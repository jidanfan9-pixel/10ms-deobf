import asyncio
import io
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

import discord
from discord import app_commands
from discord.ext import commands

CONFIG_FILE = Path(os.getenv("DEOBF_CONFIG", "config.json"))
try:
    CONFIG = json.loads(CONFIG_FILE.read_text(encoding="utf-8")) if CONFIG_FILE.exists() else {}
except json.JSONDecodeError as error:
    raise SystemExit(f"JSON 配置文件格式错误：{CONFIG_FILE}：{error}") from error


def setting(name: str, default: str = "") -> str:
    """Environment variables override config.json values."""
    return os.getenv(name, str(CONFIG.get(name, default))).strip()


DISCORD_TOKEN = setting("DISCORD_TOKEN")
DISCORD_CLIENT_ID = setting("DISCORD_CLIENT_ID")
DISCORD_GUILD_ID = setting("DISCORD_GUILD_ID")
DEOBF_API_URL = setting("DEOBF_API_URL", "http://127.0.0.1:3000/deobf")
BOT_NAME = setting("BOT_NAME", "斯大林")
MAX_CODE_LENGTH = int(setting("MAX_CODE_LENGTH", "5000000"))
MAX_OUTPUT_MESSAGE_LENGTH = 1700

# Only these Discord user IDs may use hosting-control commands.
ADMIN_USER_IDS = {
    item.strip() for item in setting("ADMIN_USER_IDS").split(",") if item.strip()
}

if not DISCORD_TOKEN:
    raise SystemExit("缺少 DISCORD_TOKEN，请通过环境变量或 config.json 注入，不要把 Token 写入源码。")
if not DISCORD_CLIENT_ID:
    raise SystemExit("缺少 DISCORD_CLIENT_ID，请填写 Discord Developer Portal 的 Application ID。")
if not ADMIN_USER_IDS:
    raise SystemExit("缺少 ADMIN_USER_IDS，请填写允许控制 bot 的 Discord 用户 ID，多个 ID 用逗号分隔。")


class DeobfBot(commands.Bot):
    def __init__(self):
        intents = discord.Intents.default()
        super().__init__(command_prefix="!", intents=intents)
        self.started_at = None

    async def setup_hook(self):
        if DISCORD_GUILD_ID:
            guild = discord.Object(id=int(DISCORD_GUILD_ID))
            self.tree.copy_global_to(guild=guild)
            synced = await self.tree.sync(guild=guild)
            print(f"[{BOT_NAME}] 已同步 {len(synced)} 个 Guild 斜杠命令")
        else:
            synced = await self.tree.sync()
            print(f"[{BOT_NAME}] 已同步 {len(synced)} 个全局斜杠命令")

    async def on_ready(self):
        import datetime
        self.started_at = self.started_at or datetime.datetime.now(datetime.timezone.utc)
        print(f"[{BOT_NAME}] 已登录为 {self.user}，API: {DEOBF_API_URL}")
        await self.change_presence(
            status=discord.Status.online,
            activity=discord.Game(name="/deobf 解混淆 Lua"),
        )


bot = DeobfBot()


def is_admin(interaction: discord.Interaction) -> bool:
    return str(interaction.user.id) in ADMIN_USER_IDS


def require_admin(interaction: discord.Interaction):
    if not is_admin(interaction):
        raise PermissionError("只有配置中的管理员可以执行此操作。")


def call_deobf_api(code: str) -> dict:
    if not code.strip():
        raise ValueError("没有提供 Lua 代码。")
    if len(code.encode("utf-8")) > MAX_CODE_LENGTH:
        raise ValueError(f"代码过长，当前限制为 {MAX_CODE_LENGTH // 1_000_000}MB。")

    payload = json.dumps({"code": code}, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        DEOBF_API_URL,
        data=payload,
        headers={"Content-Type": "application/json", "User-Agent": "deobf-discord-bot/1.1"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        try:
            detail = json.loads(body).get("message", body)
        except json.JSONDecodeError:
            detail = body
        raise RuntimeError(f"API 返回 HTTP {error.code}: {detail}") from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"无法连接反混淆 API：{error.reason}") from error


def make_code_block(text: str) -> str:
    safe = text.replace("```", "` ` `")
    return f"```lua\n{safe}\n```"


def output_filename(input_name: str | None) -> str:
    name = Path(input_name or "script.lua").name
    stem = Path(name).stem or "script"
    return f"{stem}.deobfuscated.lua"


@bot.tree.command(name="ping", description="检查 bot 是否在线")
async def ping(interaction: discord.Interaction):
    await interaction.response.send_message(
        f"Pong！延迟 {round(bot.latency * 1000)}ms", ephemeral=True
    )


@bot.tree.command(name="status", description="查看 bot 托管状态")
async def status(interaction: discord.Interaction):
    require_admin(interaction)
    await interaction.response.send_message(
        f"✅ 正在运行\nBot：{BOT_NAME}\nAPI：{DEOBF_API_URL}\n管理员数量：{len(ADMIN_USER_IDS)}\nPID：{os.getpid()}",
        ephemeral=True,
    )


@bot.tree.command(name="settings", description="查看当前 bot 设置")
async def settings(interaction: discord.Interaction):
    require_admin(interaction)
    await interaction.response.send_message(
        "当前设置：\n"
        f"API：`{DEOBF_API_URL}`\n"
        f"单文件限制：`{MAX_CODE_LENGTH // 1_000_000}MB`\n"
        f"支持附件：任意文件名（按 UTF-8 文本读取）\n"
        f"自动输出：`原文件名.deobfuscated.lua`\n"
        "Token：已隐藏",
        ephemeral=True,
    )


@bot.tree.command(name="stop", description="立即停止 bot（仅管理员）")
async def stop(interaction: discord.Interaction):
    require_admin(interaction)
    await interaction.response.send_message("⏹️ 正在立即停止 bot。需要重新托管时，请重新启动启动器。", ephemeral=True)
    await asyncio.sleep(0.4)
    await bot.close()


@bot.tree.command(name="deobf", description="解混淆任意 Lua/Luau 文本文件")
@app_commands.describe(
    code="直接粘贴 Lua/Luau 代码",
    file="上传任意 Lua/Luau 文本文件（.lua、.luau、.txt 等均可）",
)
async def deobf(
    interaction: discord.Interaction,
    code: str | None = None,
    file: discord.Attachment | None = None,
):
    await interaction.response.defer()

    try:
        if code and file:
            raise ValueError("请只选择 code 或 file 其中一种输入方式。")

        input_name = file.filename if file else "script.lua"
        if file:
            if file.size > MAX_CODE_LENGTH:
                raise ValueError(f"附件过大，当前限制为 {MAX_CODE_LENGTH // 1_000_000}MB。")
            raw = await file.read()
            if len(raw) > MAX_CODE_LENGTH:
                raise ValueError(f"附件过大，当前限制为 {MAX_CODE_LENGTH // 1_000_000}MB。")
            code = raw.decode("utf-8", errors="replace")

        if not code or not code.strip():
            raise ValueError("请提供 Lua/Luau 代码，或上传文本文件。")

        result = await asyncio.to_thread(call_deobf_api, code)
        if not result.get("success"):
            await interaction.followup.send(f"解混淆失败：{result.get('message', '未知错误')}")
            return

        output = result.get("deobfuscated", "")
        report = result.get("report") or {}
        detected = result.get("detectedObfuscator") or "未识别"
        input_bytes = report.get("inputBytes", len(code.encode("utf-8")))
        output_bytes = report.get("outputBytes", len(output.encode("utf-8")))
        summary = f"✅ 完成\n检测：{detected}\n输入：{input_bytes} bytes → 输出：{output_bytes} bytes"

        if len(output) <= MAX_OUTPUT_MESSAGE_LENGTH:
            await interaction.followup.send(f"{summary}\n\n{make_code_block(output)}")
        else:
            output_file = discord.File(io.BytesIO(output.encode("utf-8")), filename=output_filename(input_name))
            await interaction.followup.send(
                content=f"{summary}\n结果较长，已作为 Lua 文件发送。",
                file=output_file,
            )
    except Exception as error:
        print(f"处理 /deobf 失败: {error}")
        await interaction.followup.send(f"处理失败：{error}")


if __name__ == "__main__":
    bot.run(DISCORD_TOKEN)
