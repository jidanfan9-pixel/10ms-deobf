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
