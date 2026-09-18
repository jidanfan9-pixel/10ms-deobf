const {
  AttachmentBuilder,
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder
} = require('discord.js');
const { deobfuscate } = require('./deobf');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const BOT_NAME = process.env.BOT_NAME || '斯大林';
const MAX_CODE_LENGTH = Number.parseInt(process.env.MAX_CODE_LENGTH || '5000000', 10);
const MAX_ATTACHMENT_BYTES = Math.min(
  Number.parseInt(process.env.MAX_ATTACHMENT_BYTES || String(MAX_CODE_LENGTH), 10),
  MAX_CODE_LENGTH
);

if (!TOKEN) {
  console.error('缺少 DISCORD_TOKEN。请复制 .env.example 并通过环境变量注入新的 Discord Bot Token。');
  process.exit(1);
}
if (!CLIENT_ID) {
  console.error('缺少 DISCORD_CLIENT_ID。请填写 Discord Developer Portal 中的 Application ID。');
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName('deobf')
    .setDescription('解混淆 Lua 代码（支持文本或 .lua/.txt 附件）')
    .addStringOption(option =>
      option.setName('code').setDescription('直接粘贴 Lua 代码').setRequired(false)
    )
    .addAttachmentOption(option =>
      option.setName('file').setDescription('上传 .lua 或 .txt 文件').setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('检查 bot 是否在线')
].map(command => command.toJSON());

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const route = GUILD_ID
    ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
    : Routes.applicationCommands(CLIENT_ID);
  await rest.put(route, { body: commands });
  console.log(`[${BOT_NAME}] 已注册 ${commands.length} 个斜杠命令${GUILD_ID ? `（Guild ${GUILD_ID}）` : '（全局）'}`);
}

function truncateForDiscord(text, max = 1800) {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 40)}\n...（结果过长，已以文件发送）`;
}

function codeBlock(text) {
  const fence = String.fromCharCode(96).repeat(3);
  return `${fence}lua\n${truncateForDiscord(text)}\n${fence}`;
}

async function readAttachment(attachment) {
  if (!attachment) return null;
  const filename = attachment.name || '';
  if (!/\.(lua|txt)$/i.test(filename)) {
    throw new Error('附件必须是 .lua 或 .txt 文件。');
  }
  if (attachment.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`附件过大，当前限制为 ${Math.floor(MAX_ATTACHMENT_BYTES / 1_000_000)}MB。`);
  }
  const response = await fetch(attachment.url);
  if (!response.ok) throw new Error(`读取附件失败（HTTP ${response.status}）。`);
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_CODE_LENGTH) {
    throw new Error(`代码过长，当前限制为 ${Math.floor(MAX_CODE_LENGTH / 1_000_000)}MB。`);
  }
  return text;
}

client.once('ready', async readyClient => {
  console.log(`[${BOT_NAME}] 已登录为 ${readyClient.user.tag}`);
  readyClient.user.setPresence({ activities: [{ name: '/deobf 解混淆 Lua', type: 0 }], status: 'online' });
  try {
    await registerCommands();
  } catch (error) {
    console.error('注册斜杠命令失败:', error);
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'ping') {
    return interaction.reply({ content: `Pong！延迟 ${client.ws.ping}ms`, ephemeral: true });
  }
  if (interaction.commandName !== 'deobf') return;

  await interaction.deferReply();
  try {
    const codeOption = interaction.options.getString('code');
    const attachment = interaction.options.getAttachment('file');
    if (codeOption && attachment) throw new Error('请只选择 code 或 file 其中一种输入方式。');
    const code = codeOption || await readAttachment(attachment);
    if (!code || !code.trim()) throw new Error('请提供 Lua 代码，或上传 .lua/.txt 文件。');
    if (code.length > MAX_CODE_LENGTH) {
      throw new Error(`代码过长，当前限制为 ${Math.floor(MAX_CODE_LENGTH / 1_000_000)}MB。`);
    }

    const result = deobfuscate(code);
    if (!result.success) {
      return interaction.editReply(`解混淆失败：${result.message || '未知错误'}`);
    }

    const output = result.deobfuscated || '';
    const report = result.report || {};
    const summary = `✅ 完成\n检测：${result.detectedObfuscator || '未识别'}\n输入：${report.inputBytes || Buffer.byteLength(code)} bytes → 输出：${report.outputBytes || Buffer.byteLength(output)} bytes`;
    if (output.length <= 1700) {
      return interaction.editReply(`${summary}\n\n${codeBlock(output)}`);
    }

    const file = new AttachmentBuilder(Buffer.from(output, 'utf8'), { name: 'deobfuscated.lua' });
    return interaction.editReply({ content: `${summary}\n结果较长，已作为文件发送。`, files: [file] });
  } catch (error) {
    console.error('处理 /deobf 失败:', error);
    return interaction.editReply(`处理失败：${error.message || String(error)}`);
  }
});

client.login(TOKEN).catch(error => {
  console.error('Discord 登录失败，请确认 Token 有效且未泄露/撤销后重新生成。', error);
  process.exit(1);
});

process.on('SIGINT', () => client.destroy());
process.on('SIGTERM', () => client.destroy());

module.exports = { readAttachment, truncateForDiscord };

if (require.main === module) {
  // Importing this file starts the bot; this branch documents the intended entry point.
}

// Keep the process alive when this file is launched with `node bot.js`.
