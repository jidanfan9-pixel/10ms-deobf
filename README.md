# 10ms-deobf

Roblox Lua 反混淆 API，并内置 Discord 斜杠命令 bot。

## Discord Bot

1. 在 Discord Developer Portal 创建 Bot，启用必要的 Bot 权限，并复制 Application ID。
2. 复制配置模板：`cp .env.example .env`。
3. 填入**新生成的** `DISCORD_TOKEN` 与 `DISCORD_CLIENT_ID`。不要把 Token 提交到 Git。
4. 安装依赖并启动：

```bash
npm install
set -a && . ./.env && set +a
npm run start:bot
```

Bot 命令：

- `/deobf code:<Lua代码>`：直接解混淆
- `/deobf file:<.lua/.txt>`：上传文件解混淆；结果过长时自动返回 `deobfuscated.lua`
- `/ping`：检查在线状态

开发时可设置 `DISCORD_GUILD_ID`，命令会立即注册到指定服务器；不设置时注册为全局命令，Discord 可能需要一段时间同步。

## API

```bash
npm start
curl -X POST http://localhost:3000/deobf \
  -H 'Content-Type: application/json' \
  -d '{"code":"print(\"hello\")"}'
```

## 安全提示

Discord Bot Token 等同于密码。若曾经在聊天、日志或截图中暴露，应在 Developer Portal 立即重置，并只通过环境变量注入新 Token。

## Python Bot JSON 配置

复制 `config.example.json` 为 `config.json`。Python bot 会自动读取同目录的 `config.json`，环境变量优先级更高：

```bash
cp config.example.json config.json
# 编辑 config.json，填写 DISCORD_TOKEN 和 DISCORD_CLIENT_ID
pip install -r requirements.txt
python discord_bot.py
```

不要把真实 Token 写入 Git；`config.json` 已加入 `.gitignore`。也可以通过 `DEOBF_CONFIG=/path/to/config.json` 指定配置文件位置。

## 长时间托管与控制

### 配置管理员

在 `config.json` 中填写你的 Discord 用户 ID：

```json
"ADMIN_USER_IDS": "123456789012345678"
```

多个管理员用英文逗号分隔。只有这些用户可以执行托管控制命令。

### 新增命令

- `/deobf`：上传任意 Lua/Luau 文本文件，不限制 `.lua`、`.luau`、`.txt` 扩展名；长结果会作为 `原文件名.deobfuscated.lua` 下载。
- `/status`：查看运行状态、API、PID 和管理员数量。
- `/settings`：查看当前设置，不显示 Token。
- `/stop`：向 Discord 回复后立即关闭当前 bot 进程。
- `/ping`：检查在线状态。

### 持续运行一星期或更久

不要直接运行 `python discord_bot.py`，使用自动重启启动器：

```bash
python run_bot.py
```

启动器会在 bot 意外崩溃或网络异常退出后自动重启，因此可以长期运行。请把它放在不会休眠、不会自动清理进程的 VPS、云主机或持续运行的电脑上。关闭 py4 软件本身是否会继续运行，取决于 py4 是否提供后台托管；普通桌面进程退出后，Python 进程通常也会结束。

### 关于立即停止和重新开启

`/stop` 会立即关闭 bot。进程关闭后无法再接收 Discord 指令，因此不能靠 Discord 中的 `/start` 重新打开。重新开启方式是重新运行：

```bash
python run_bot.py
```

如果希望 `/stop` 只暂停处理、但仍保留 Discord 在线状态，可以改成“暂停模式”；这样 `/start` 才能在 Discord 内生效。当前版本按你的要求采用真正关闭进程的方式。

### Windows / py4 长期运行建议

如果 py4 支持后台任务或守护运行，请把启动命令设置为：

```bash
python run_bot.py
```

如果它只支持单次脚本运行，则退出软件后无法保证 bot 继续托管，需要使用 VPS、系统服务或 py4 自带的持久托管功能。
