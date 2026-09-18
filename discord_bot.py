import asyncio
import json
import os
import urllib.error
import urllib.request

import discord
from discord import app_commands
from discord.ext import commands

DISCORD_TOKEN = os.getenv("DISCORD_TOKEN", "").strip()
DISCORD_CLIENT_ID = os.getenv("DISCORD_CLIENT_ID", "").strip()
DISCORD_GUILD_ID = os.getenv("DISCORD_GUILD_ID", "").strip()
DEOBF_API_URL = os.getenv("DEOBF_API_URL", "http://127.0.0.1:3000/deobf").strip()
BOT_NAME = os.getenv("BOT_NAME", "斯大林")
MAX_CODE_LENGTH = int(os.getenv("MAX_CODE_LENGTH", "5000000"))
MAX_OUTPUT_MESSAGE_LENGTH = 1700

if not DISCORD_TOKEN:
    raise SystemExit(
        "缺少 DISCORD_TOKEN。请在 py4 的环境变量中设置它，不要把 Token 写进脚本。"
    )
if not DISCORD_CLIENT_ID:
    raise SystemExit("缺少 DISCORD_CLIENT_ID，请填写 Discord Developer Portal 的 Application ID。")


class DeobfBot(commands.Bot):
    def __init__(self):
        intents = discord.Intents.default()
        super().__init__(command_prefix="!", intents=intents)

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
        print(f"[{BOT_NAME}] 已登录为 {self.user}，API: {DEOBF_API_URL}")
        await self.change_presence(
            status=discord.Status.online,
            activity=discord.Game(name="/deobf 解混淆 Lua"),
        )


bot = DeobfBot()


def call_deobf_api(code: str) -> dict:
    if not code.strip():
        raise ValueError("没有提供 Lua 代码。")
    if len(code.encode("utf-8")) > MAX_CODE_LENGTH:
        raise ValueError(f"代码过长，当前限制为 {MAX_CODE_LENGTH // 1_000_000}MB。")

    payload = json.dumps({"code": code}, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        DEOBF_API_URL,
        data=payload,
        headers={"Content-Type": "application/json", "User-Agent": "deobf-discord-bot/1.0"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            body = response.read().decode("utf-8")
            return json.loads(body)
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
    # 避免用户代码中的 ``` 提前结束 Discord 代码块。
    safe = text.replace("```", "` ` `")
    return f"```lua\n{safe}\n```"


@bot.tree.command(name="ping", description="检查 bot 是否在线")
async def ping(interaction: discord.Interaction):
    await interaction.response.send_message(
        f"Pong！延迟 {round(bot.latency * 1000)}ms", ephemeral=True
    )


@bot.tree.command(name="deobf", description="解混淆 Lua 代码")
@app_commands.describe(
    code="直接粘贴 Lua 代码",
    file="上传 .lua 或 .txt 文件",
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

        if file:
            filename = (file.filename or "").lower()
            if not filename.endswith((".lua", ".txt")):
                raise ValueError("附件必须是 .lua 或 .txt 文件。")
            if file.size > MAX_CODE_LENGTH:
                raise ValueError(f"附件过大，当前限制为 {MAX_CODE_LENGTH // 1_000_000}MB。")
            code = (await file.read()).decode("utf-8", errors="replace")

        if not code or not code.strip():
            raise ValueError("请提供 Lua 代码，或上传 .lua/.txt 文件。")

        result = await asyncio.to_thread(call_deobf_api, code)
        if not result.get("success"):
            await interaction.followup.send(
                f"解混淆失败：{result.get('message', '未知错误')}"
            )
            return

        output = result.get("deobfuscated", "")
        report = result.get("report") or {}
        detected = result.get("detectedObfuscator") or "未识别"
        input_bytes = report.get("inputBytes", len(code.encode("utf-8")))
        output_bytes = report.get("outputBytes", len(output.encode("utf-8")))
        summary = (
            "✅ 完成\n"
            f"检测：{detected}\n"
            f"输入：{input_bytes} bytes → 输出：{output_bytes} bytes"
        )

        if len(output) <= MAX_OUTPUT_MESSAGE_LENGTH:
            await interaction.followup.send(f"{summary}\n\n{make_code_block(output)}")
        else:
            output_file = discord.File(
                fp=__import__("io").BytesIO(output.encode("utf-8")),
                filename="deobfuscated.lua",
            )
            await interaction.followup.send(
                content=f"{summary}\n结果较长，已作为文件发送。",
                file=output_file,
            )
    except Exception as error:
        print(f"处理 /deobf 失败: {error}")
        await interaction.followup.send(f"处理失败：{error}")


if __name__ == "__main__":
    bot.run(DISCORD_TOKEN)
