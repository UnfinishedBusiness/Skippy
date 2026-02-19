const { Client, GatewayIntentBits, Partials, REST, Routes, MessageFlags, ApplicationCommandOptionType } = require('discord.js');
const path = require('path');
const fs = require('fs');

let client = null;
let guild = null;

// Tracks channels where /stop has been issued so typing indicators stop immediately
const stoppedTypingChannels = new Set();

function loadConfig() {
  if (global.SkippyConfig && global.SkippyConfig.discord) {
    return global.SkippyConfig.discord;
  }
  throw new Error('Global SkippyConfig.discord not found!');
}

function saveConfig() {
  const { CONFIG_FILE } = require('./paths');
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(global.SkippyConfig, null, 2), 'utf8');
}

// Utility to get messageHistoryLimit from discord config
function getMessageHistoryLimit() {
  try {
    if (global.SkippyConfig && global.SkippyConfig.discord && typeof global.SkippyConfig.discord.messageHistoryLimit === 'number') {
      return global.SkippyConfig.discord.messageHistoryLimit;
    }
    // fallback to reading file if global not set
    const { CONFIG_FILE } = require('./paths');
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (config.discord && typeof config.discord.messageHistoryLimit === 'number') {
      return config.discord.messageHistoryLimit;
    }
  } catch (e) {}
  return 20; // default fallback
}

// Check if a bot message should be excluded from context
function shouldExcludeBotMessage(content) {
  if (!content || typeof content !== 'string') return true;
  
  const trimmed = content.trim();
  
  // Exclude progress/status messages from bot context
  const operationalPatterns = [
    /^🤔\s+Analyzing/i,
    /^🤖\s+Reasoning:/i,
    /^⚙️\s+Processing:/i,
    /^✅\s+All steps completed/i,
    /^✅\s+Complete/i,
    /^❌\s+Error/i,
    /^⚠️\s+Warning/i
  ];
  
  // Check against patterns
  for (const pattern of operationalPatterns) {
    if (pattern.test(trimmed)) {
      return true;
    }
  }
  
  // Also exclude very short operational messages
  const shortOpsPatterns = [
    /^(Thinking|Processing|Working|Loading|Fetching|Executing|Complete|Success|Error|Warning)\b/i,
    /^(Step \d+ of \d+|Executing \w+ \(\d+\/\d+\))/i,
    /^(Analyzing|Generating|Processing|Working)\b/i
  ];
  
  for (const pattern of shortOpsPatterns) {
    if (pattern.test(trimmed)) {
      return true;
    }
  }
  
  return false;
}

// ===== MESSAGE HISTORY FUNCTIONS =====

async function getLastMessages(channelId, userId, limit = null) {
  if (!client) throw new Error('Discord client not initialized');
  const messageLimit = limit || getMessageHistoryLimit();
  try {
    let channel = client.channels.cache.get(channelId);
    if (!channel) {
      channel = await client.channels.fetch(channelId);
    }
    let messages;
    const cachedMessages = Array.from(channel.messages.cache.values());
    if (cachedMessages.length >= messageLimit) {
      messages = cachedMessages
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
        .slice(-messageLimit);
    } else {
      const fetchedMessages = await channel.messages.fetch({ limit: messageLimit - cachedMessages.length });
      const fetchedArray = Array.from(fetchedMessages.values());
      messages = [...cachedMessages, ...fetchedArray]
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
        .slice(-messageLimit);
    }
    
    const formattedHistory = messages
      .reverse()
      .map(message => ({
        author: message.author.username,
        authorId: message.author.id,
        content: message.content,
        timestamp: message.createdAt.toISOString(),
        isBot: message.author.bot
      }))
      .filter(msg => {
        // Filter out empty messages
        if (!msg.content || !msg.content.trim()) return false;
        
        // Always include user messages
        if (!msg.isBot) return true;
        
        // For bot messages, check if they should be excluded from context
        return !shouldExcludeBotMessage(msg.content);
      });
    return formattedHistory;
  } catch (error) {
    const logger = global.logger || console;
    logger.error('Error fetching message history:', error);
    return [];
  }
}

function formatMessageHistory(messages, includeTimestamps = false) {
  if (messages.length === 0) return '';

  return messages.map(message => {
    const speaker = message.isBot ? 'Bot' : message.author;
    const timestamp = includeTimestamps ? ` (${new Date(message.timestamp).toLocaleTimeString()})` : '';
    return `${speaker}${timestamp}: ${message.content}`;
  }).join('\n');
}

async function buildContextWithHistory(message, userId, currentPrompt, limit = null) {
  try {
    const messageHistory = await getLastMessages(message.channel.id, userId, limit);
    const historyContext = formatMessageHistory(messageHistory, true);
    const fullContext = historyContext 
      ? `Recent conversation:\n${historyContext}\n\nCurrent request: ${currentPrompt}`
      : currentPrompt;
    return fullContext;
  } catch (error) {
    const logger = global.logger || console;
    logger.error('Error building context with history:', error);
    return currentPrompt;
  }
}

// ===== END MESSAGE HISTORY FUNCTIONS =====

// Enhanced status update with file and HTTP endpoint info
async function deleteStatusMessages(statusMessages) {
  if (!statusMessages || statusMessages.length === 0) return;
  for (const msg of statusMessages) {
    try {
      await msg.delete();
    } catch {
      // Message may already be gone (e.g. in DMs where delete isn't supported)
    }
  }
}

async function sendStatusUpdate(message, status, details = '', toolInfo = null) {
  if (message && status) {
    try {
      let statusEmoji = '⚙️';
      switch(status) {
        case 'thinking': statusEmoji = '🤔'; break;
        case 'processing': statusEmoji = '⚙️'; break;
        case 'complete': statusEmoji = '✅'; break;
        case 'error': statusEmoji = '❌'; break;
        default: statusEmoji = 'ℹ️'; break;
      }
      
      let messageText = `${statusEmoji} ${status}`;
      if (details) {
        messageText += `: ${details}`;
      }
      
      // Add tool-specific information
      if (toolInfo) {
        if (toolInfo.tool === 'FileReadTool' || toolInfo.tool === 'FileWriteTool' || toolInfo.tool === 'PatchFileTool') {
          if (toolInfo.arguments && toolInfo.arguments.filepath) {
            messageText += ` (File: ${toolInfo.arguments.filepath})`;
          } else if (toolInfo.arguments && Array.isArray(toolInfo.arguments) && toolInfo.arguments[0]) {
            messageText += ` (File: ${toolInfo.arguments[0]})`;
          }
        } else if (toolInfo.tool === 'HttpRequestTool') {
          if (toolInfo.arguments && toolInfo.arguments.url) {
            messageText += ` (URL: ${toolInfo.arguments.url})`;
          } else if (toolInfo.arguments && Array.isArray(toolInfo.arguments) && toolInfo.arguments[1]) {
            messageText += ` (URL: ${toolInfo.arguments[1]})`;
          }
        }
      }
      
      let sent;
      if (messageText.length < 1800) {
        sent = await message.channel.send(messageText);
      } else {
        sent = await message.channel.send(`${statusEmoji} ${status}: ${details.substring(0, 1750)}...`);
      }
      return sent;
    } catch (e) {
      const logger = global.logger || console;
      logger.warn('[sendStatusUpdate] Failed to send status update:', e.message);
    }
  }
}

// Enhanced reasoning message with tool context
async function sendDiscordReasoning(message, reasoning, toolInfo = null) {
  if (message && reasoning && typeof reasoning === 'string' && reasoning.trim()) {
    try {
      let reasoningText = `🤖 Reasoning: ${reasoning}`;
      
      // Add tool-specific information to reasoning
      if (toolInfo) {
        if (toolInfo.tool === 'FileReadTool' || toolInfo.tool === 'FileWriteTool' || toolInfo.tool === 'PatchFileTool') {
          if (toolInfo.arguments && toolInfo.arguments.filepath) {
            reasoningText += ` (File: ${toolInfo.arguments.filepath})`;
          } else if (toolInfo.arguments && Array.isArray(toolInfo.arguments) && toolInfo.arguments[0]) {
            reasoningText += ` (File: ${toolInfo.arguments[0]})`;
          }
        } else if (toolInfo.tool === 'HttpRequestTool') {
          if (toolInfo.arguments && toolInfo.arguments.url) {
            reasoningText += ` (URL: ${toolInfo.arguments.url})`;
          } else if (toolInfo.arguments && Array.isArray(toolInfo.arguments) && toolInfo.arguments[1]) {
            reasoningText += ` (URL: ${toolInfo.arguments[1]})`;
          }
        }
      }
      
      // Only send if not too long
      let sent;
      if (reasoningText.length < 1800) {
        sent = await message.channel.send(reasoningText);
      } else {
        // Truncate reasoning if too long
        sent = await message.channel.send(`${reasoningText.substring(0, 1770)}...`);
      }
      return sent;
    } catch (e) {
      const logger = global.logger || console;
      logger.warn('[sendDiscordReasoning] Failed to send reasoning message:', e.message);
    }
  }
}

function startDiscordHandler(onMessage) {
  const config = loadConfig();
  const logger = global.logger || console;
  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages
    ],
    partials: [Partials.Channel]
  });
  const historyLimit = getMessageHistoryLimit();
  logger.info(`Using message history limit: ${historyLimit}`);
  client.once('clientReady', () => {
    guild = client.guilds.cache.get(config.guildId);
    if (!guild) {
      logger.error(`Guild not found: ${config.guildId}`);
    } else {
      logger.info(`Connected to Discord guild: ${guild.name}`);
    }
  });

  client.on('messageCreate', async (message) => {
    // Ignore messages from bots
    if (message.author.bot) return;

    // Use the shouldRespondToMessage logic
    const shouldRespond = await shouldRespondToMessage(message, client);
    if (!shouldRespond) return;

    // Handle guild messages for the configured guild
    if (message.guild && message.guild.id === config.guildId && !message.author.bot) {
      logger.info(`Received from Discord: ${message.author.username}: ${message.content}`);
      
      // Get context with message history
      const contextPrompt = await buildContextWithHistory(message, message.author.id, message.content, historyLimit);
      
      // Send typing indicator — stops if /stop is issued for this channel
      let typingActive = true;
      const channelId = message.channel.id;
      stoppedTypingChannels.delete(channelId); // clear any leftover from a previous stop
      const sendTyping = () => {
        if (typingActive && !stoppedTypingChannels.has(channelId) && message.channel.sendTyping) {
          message.channel.sendTyping();
          setTimeout(sendTyping, 8000);
        }
      };
      sendTyping();

      const { runPrompt } = require('./prompt');

      const imageUrls = [...message.attachments.values()]
        .filter(att => att.contentType?.startsWith('image/'))
        .map(att => att.url);

      runPrompt({
        prompt: contextPrompt,
        discordMessage: message,
        imageUrls: imageUrls.length > 0 ? imageUrls : undefined
      }, async (finalResult, done) => {
        if (done) {
          typingActive = false;
          stoppedTypingChannels.delete(channelId);
          let answer = (finalResult && typeof finalResult === 'object' && 'last_response' in finalResult && typeof finalResult.last_response.final_answer === 'string')
            ? finalResult.last_response.final_answer
            : (typeof finalResult === 'string' ? finalResult : '');
          if (answer && answer.trim()) {
            const maxLen = 2000;
            for (let i = 0; i < answer.length; i += maxLen) {
              sendMessage(channelId, answer.slice(i, i + maxLen));
            }
          }
          await deleteStatusMessages(finalResult && finalResult.status_messages);
        }
      }).catch(err => {
        typingActive = false;
        stoppedTypingChannels.delete(channelId);
        logger.error('Ollama error: ' + (err?.message || err));
        sendMessage(channelId, 'Sorry, there was an error processing your request.');
      });

      onMessage && onMessage(message);
    }

    // Handle direct messages (DMs) to the bot
    if (!message.guild && !message.author.bot) {
      logger.info(`Received DM from ${message.author.username}: ${message.content}`);

      // Get context with message history
      const contextPrompt = await buildContextWithHistory(message, message.author.id, message.content, historyLimit);

      // Send typing indicator — stops if /stop is issued for this channel
      let typingActive = true;
      const channelId = message.channel.id;
      stoppedTypingChannels.delete(channelId);
      const sendTyping = () => {
        if (typingActive && !stoppedTypingChannels.has(channelId) && message.channel.sendTyping) {
          message.channel.sendTyping();
          setTimeout(sendTyping, 8000);
        }
      };
      sendTyping();

      const { runPrompt } = require('./prompt');

      const imageUrls = [...message.attachments.values()]
        .filter(att => att.contentType?.startsWith('image/'))
        .map(att => att.url);

      runPrompt({
        prompt: contextPrompt,
        discordMessage: message,
        imageUrls: imageUrls.length > 0 ? imageUrls : undefined
      }, async (finalResult, done) => {
        if (done) {
          typingActive = false;
          stoppedTypingChannels.delete(channelId);
          let answer = (finalResult && typeof finalResult === 'object' && 'last_response' in finalResult && typeof finalResult.last_response.final_answer === 'string')
            ? finalResult.last_response.final_answer
            : (typeof finalResult === 'string' ? finalResult : '');
          if (answer && answer.trim()) {
            const maxLen = 2000;
            for (let i = 0; i < answer.length; i += maxLen) {
              sendMessage(channelId, answer.slice(i, i + maxLen));
            }
          }
          await deleteStatusMessages(finalResult && finalResult.status_messages);
        }
      }).catch(err => {
        typingActive = false;
        stoppedTypingChannels.delete(channelId);
        logger.error('Ollama error: ' + (err?.message || err));
        sendMessage(channelId, 'Sorry, there was an error processing your request.');
      });

      onMessage && onMessage(message);
    }
  });

  // Register /stop slash command once the client is ready
  client.once('clientReady', async () => {
    const rest = new REST().setToken(config.token);
    const commands = [
      { name: 'stop', description: 'Stop the currently running prompt in this channel' },
      { name: 'clear', description: 'Clear all message history in this channel' },
      {
        name: 'model',
        description: 'List available models or switch the active model',
        options: [
          {
            type: ApplicationCommandOptionType.Subcommand,
            name: 'list',
            description: 'List all models available on the Ollama server',
          },
          {
            type: ApplicationCommandOptionType.Subcommand,
            name: 'set',
            description: 'Switch to a different model',
            options: [
              {
                type: ApplicationCommandOptionType.String,
                name: 'name',
                description: 'Model name to switch to',
                required: true,
              },
            ],
          },
        ],
      },
      {
        name: 'context',
        description: 'Manage persistent context items injected into every prompt',
        options: [
          {
            type: ApplicationCommandOptionType.Subcommand,
            name: 'add',
            description: 'Add a file or image to the persistent context',
            options: [
              {
                type: ApplicationCommandOptionType.String,
                name: 'type',
                description: 'Type of item to add',
                required: true,
                choices: [
                  { name: 'file',  value: 'file'  },
                  { name: 'image', value: 'image' },
                ],
              },
              {
                type: ApplicationCommandOptionType.String,
                name: 'path',
                description: 'Absolute file path or image URL',
                required: true,
              },
            ],
          },
          {
            type: ApplicationCommandOptionType.Subcommand,
            name: 'remove',
            description: 'Remove a context item by its index (from /context list)',
            options: [
              {
                type: ApplicationCommandOptionType.Integer,
                name: 'index',
                description: 'Item index (1-based, from /context list)',
                required: true,
                min_value: 1,
              },
            ],
          },
          {
            type: ApplicationCommandOptionType.Subcommand,
            name: 'list',
            description: 'List all persistent context items',
          },
          {
            type: ApplicationCommandOptionType.Subcommand,
            name: 'status',
            description: 'Show context size and token estimate',
          },
          {
            type: ApplicationCommandOptionType.Subcommand,
            name: 'clear',
            description: 'Remove all persistent context items',
          },
        ],
      },
      {
        name: 'loop_limit',
        description: 'View or change the prompt loop limit',
        options: [
          {
            type: ApplicationCommandOptionType.Subcommand,
            name: 'get',
            description: 'Show the current loop limit',
          },
          {
            type: ApplicationCommandOptionType.Subcommand,
            name: 'set',
            description: 'Set the maximum number of loop iterations per prompt',
            options: [
              {
                type: ApplicationCommandOptionType.Integer,
                name: 'limit',
                description: 'Loop limit (1–200)',
                required: true,
                min_value: 1,
                max_value: 200,
              },
            ],
          },
        ],
      },
    ];
    try {
      // Clear any global application commands (removes leftover commands from old implementations)
      await rest.put(Routes.applicationCommands(client.user.id), { body: [] });
      // Register guild-scoped commands (instant deployment, channel-specific abort support)
      await rest.put(Routes.applicationGuildCommands(client.user.id, config.guildId), { body: commands });
      logger.info(`[discord] Registered slash commands: ${commands.map(c => '/' + c.name).join(', ')} (global commands cleared)`);
    } catch (err) {
      logger.error('[discord] Failed to register slash commands: ' + err.message);
    }
  });

  // Handle /stop — only aborts the prompt chain running in the same channel
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === 'stop') {
      const { requestAbort } = require('./prompt');
      stoppedTypingChannels.add(interaction.channelId);
      requestAbort(interaction.channelId);
      logger.info(`[discord] /stop by ${interaction.user.username} in channel ${interaction.channelId}`);
      await interaction.reply({ content: 'Stopping the current prompt in this channel.', flags: MessageFlags.Ephemeral });
    }
    
    if (interaction.commandName === 'clear') {
      try {
        const channel = interaction.channel;
        // Fetch all messages in the channel (Discord limits to 100 per fetch)
        let messages = [];
        let lastId = null;
        let done = false;
        
        while (!done) {
          const fetched = await channel.messages.fetch({ 
            limit: 100, 
            before: lastId 
          });
          
          if (fetched.size === 0) {
            done = true;
          } else {
            messages.push(...fetched.values());
            lastId = fetched.last().id;
            if (fetched.size < 100) done = true;
          }
        }
        
        // Filter out messages older than 14 days (Discord limitation)
        const twoWeeksAgo = Date.now() - (14 * 24 * 60 * 60 * 1000);
        const deletableMessages = messages.filter(msg => msg.createdTimestamp > twoWeeksAgo);
        const skippedCount = messages.length - deletableMessages.length;
        
        if (deletableMessages.length > 0) {
          // Bulk delete in chunks of 100
          for (let i = 0; i < deletableMessages.length; i += 100) {
            const chunk = deletableMessages.slice(i, i + 100);
            await channel.bulkDelete(chunk, true);
          }
        }
        
        const totalCleared = deletableMessages.length;
        let response = `✅ Cleared ${totalCleared} message${totalCleared !== 1 ? 's' : ''} from this channel.`;
        if (skippedCount > 0) {
          response += ` (${skippedCount} older than 14 days could not be deleted)`;
        }
        
        logger.info(`[discord] /clear by ${interaction.user.username} in channel ${interaction.channelId}: ${totalCleared} messages cleared`);
        await interaction.reply({ content: response });
        
        // Auto-delete the confirmation after 3 seconds
        setTimeout(async () => {
          try {
            await interaction.deleteReply();
          } catch (e) {}
        }, 3000);
        
      } catch (err) {
        logger.error('[discord] /clear error:', err.message);
        await interaction.reply({ content: `❌ Error clearing messages: ${err.message}`, ephemeral: true });
      }
    }

    if (interaction.commandName === 'model') {
      try {
        const { listModelsWithDetails } = require('./ollama-cloud');
        const sub = interaction.options.getSubcommand();

        if (sub === 'list') {
          await interaction.deferReply();
          const models = await listModelsWithDetails();
          const current = global.SkippyConfig?.ollama?.model ?? '(none)';
          if (models.length === 0) {
            await interaction.editReply('⚠️ No models found (or Ollama server unreachable).');
            return;
          }
          const fmt = n => n >= 1_000_000 ? `${(n / 1_000).toLocaleString()}K` : n.toLocaleString();
          const lines = models.map(m => {
            const params = m.details?.parameter_size ?? '';
            const quant  = m.details?.quantization_level ?? '';
            const ctx    = m.contextLength ? `ctx:${fmt(m.contextLength)}` : '';
            const meta   = [params, quant, ctx].filter(Boolean).join('  ');
            const active = m.name === current ? ' ✅' : '';
            return `• \`${m.name}\`${active}${meta ? ` -  ${meta}` : ''}`;
          });
          const msg = `**Available models** (current: \`${current}\`)\n${lines.join('\n')}`;
          logger.info(`[discord] /model list by ${interaction.user.username}`);
          await interaction.editReply(msg.length <= 2000 ? msg : msg.slice(0, 1997) + '…');

        } else if (sub === 'set') {
          await interaction.deferReply();
          const name = interaction.options.getString('name');
          const { listModels } = require('./ollama-cloud');
          const available = await listModels();
          const names = available.map(m => m.name);
          if (!names.includes(name)) {
            const list = names.map(n => `\`${n}\``).join(', ') || '(none found)';
            await interaction.editReply(`❌ Model \`${name}\` not found.\nAvailable: ${list}`);
            return;
          }
          const prev = global.SkippyConfig?.ollama?.model ?? '(none)';
          if (!global.SkippyConfig) global.SkippyConfig = {};
          if (!global.SkippyConfig.ollama) global.SkippyConfig.ollama = {};
          global.SkippyConfig.ollama.model = name;
          saveConfig();
          logger.info(`[discord] /model set "${name}" (was "${prev}") by ${interaction.user.username} — saved to config`);
          await interaction.editReply(`✅ Model switched from \`${prev}\` → \`${name}\` and saved to config.`);
        }
      } catch (err) {
        logger.error('[discord] /model error: ' + err.message);
        try {
          const errMsg = `❌ Error: ${err.message}`;
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply(errMsg);
          } else {
            await interaction.reply({ content: errMsg, flags: MessageFlags.Ephemeral });
          }
        } catch (e) {}
      }
    }

    if (interaction.commandName === 'context') {
      try {
        const { addContextItem, removeContextItem, clearContextItems, getContextItems, getContextStatus } = require('./context-manager');
        const sub = interaction.options.getSubcommand();

        if (sub === 'add') {
          const type     = interaction.options.getString('type');
          const itemPath = interaction.options.getString('path');

          // Validate file exists for file-type items
          if (type === 'file' && !fs.existsSync(itemPath)) {
            await interaction.reply({ content: `❌ File not found: \`${itemPath}\``, flags: MessageFlags.Ephemeral });
            return;
          }

          addContextItem({ type, path: itemPath, addedAt: new Date().toISOString(), addedBy: interaction.user.username });
          const count = getContextItems().length;
          logger.info(`[discord] /context add ${type} "${itemPath}" by ${interaction.user.username} (${count} total)`);
          await interaction.reply({ content: `✅ Added **${type}** to context: \`${itemPath}\` (${count} item${count !== 1 ? 's' : ''} total)` });

        } else if (sub === 'remove') {
          const idx   = interaction.options.getInteger('index') - 1; // 0-based
          const items = getContextItems();
          if (idx < 0 || idx >= items.length) {
            await interaction.reply({ content: `❌ Invalid index. Use \`/context list\` to see valid indices (1–${items.length}).`, flags: MessageFlags.Ephemeral });
            return;
          }
          const removed = items[idx];
          removeContextItem(idx);
          logger.info(`[discord] /context remove ${idx + 1} ("${removed.path}") by ${interaction.user.username}`);
          await interaction.reply({ content: `✅ Removed **${removed.type}**: \`${removed.path}\`` });

        } else if (sub === 'list') {
          const items = getContextItems();
          if (items.length === 0) {
            await interaction.reply({ content: '📋 No context items. Use `/context add` to add files or images.', flags: MessageFlags.Ephemeral });
            return;
          }
          const lines = items.map((item, i) => {
            const emoji = item.type === 'file' ? '📄' : '🖼️';
            return `\`${i + 1}.\` ${emoji} **${item.type}** \`${item.path}\` *(${item.addedBy})*`;
          });
          await interaction.reply({ content: `**Persistent Context** (${items.length} item${items.length !== 1 ? 's' : ''})\n${lines.join('\n')}`, flags: MessageFlags.Ephemeral });

        } else if (sub === 'status') {
          await interaction.deferReply({ ephemeral: true });
          const { itemCount, totalChars, estimatedTokens, modelContextWindow, usedPercent, breakdown } = await getContextStatus();
          const lines = breakdown.map((item, i) => {
            const emoji  = item.type === 'file' ? '📄' : '🖼️';
            const size   = item.tokens != null ? `~${item.tokens.toLocaleString()} tokens` : 'binary';
            const errStr = item.error ? ` ❌ ${item.error}` : '';
            return `\`${i + 1}.\` ${emoji} \`${item.path}\` — ${size}${errStr}`;
          });
          const summary = [
            `**Context Status** — ${itemCount} item${itemCount !== 1 ? 's' : ''}`,
            `Files: **~${estimatedTokens.toLocaleString()} tokens** (${totalChars.toLocaleString()} chars) — ${usedPercent}% of model ctx window (${(modelContextWindow).toLocaleString()} tokens)`,
            '',
            lines.join('\n') || '*(no items)*',
          ].join('\n');
          await interaction.editReply(summary.length <= 2000 ? summary : summary.slice(0, 1997) + '…');

        } else if (sub === 'clear') {
          const count = getContextItems().length;
          clearContextItems();
          logger.info(`[discord] /context clear by ${interaction.user.username} (removed ${count} items)`);
          await interaction.reply({ content: `✅ Cleared ${count} context item${count !== 1 ? 's' : ''}.` });
        }

      } catch (err) {
        logger.error('[discord] /context error: ' + err.message);
        try {
          const errMsg = `❌ Error: ${err.message}`;
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply(errMsg);
          } else {
            await interaction.reply({ content: errMsg, flags: MessageFlags.Ephemeral });
          }
        } catch (e) {}
      }
    }

    if (interaction.commandName === 'loop_limit') {
      try {
        const sub = interaction.options.getSubcommand();
        const current = global.SkippyConfig?.prompt?.loop_limit ?? 10;

        if (sub === 'get') {
          await interaction.reply({ content: `Current loop limit: **${current}**`, flags: MessageFlags.Ephemeral });

        } else if (sub === 'set') {
          const limit = interaction.options.getInteger('limit');
          if (!global.SkippyConfig) global.SkippyConfig = {};
          if (!global.SkippyConfig.prompt) global.SkippyConfig.prompt = {};
          global.SkippyConfig.prompt.loop_limit = limit;
          saveConfig();
          logger.info(`[discord] /loop_limit set ${limit} (was ${current}) by ${interaction.user.username} — saved to config`);
          await interaction.reply({ content: `✅ Loop limit changed from **${current}** → **${limit}** and saved to config.` });
        }
      } catch (err) {
        logger.error('[discord] /loop_limit error: ' + err.message);
        try {
          const errMsg = `❌ Error: ${err.message}`;
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply(errMsg);
          } else {
            await interaction.reply({ content: errMsg, flags: MessageFlags.Ephemeral });
          }
        } catch (e) {}
      }
    }
  });

  client.login(config.token);
}

function sendMessage(channelId, content) {
  if (!client) throw new Error('Discord client not initialized');
  const channel = client.channels.cache.get(channelId);
  if (channel) {
    channel.send(content);
  } else {
    const logger = global.logger || console;
    logger.error('Channel not found:', channelId);
  }
}

async function sendDiscordMessage({ targetType, target, message }) {
  if (!client) throw new Error('Discord client not initialized');
  const logger = global.logger || console;
  try {
    if (targetType === 'user') {
      let user = null;
      if (/^\d+$/.test(target)) {
        // Numeric ID — fetch directly (always works)
        user = await client.users.fetch(target);
      } else {
        // Try cache first: check username, globalName, and displayName
        user = client.users.cache.find(u =>
          u.username === target ||
          u.globalName === target ||
          u.displayName === target
        );

        if (!user && guild) {
          // Cache miss — search guild members by name (hits the API)
          const members = await guild.members.fetch({ query: target, limit: 10 });
          const match = members.find(m =>
            m.user.username === target ||
            m.user.globalName === target ||
            m.displayName === target ||
            m.nickname === target
          );
          if (match) user = match.user;
        }
      }
      if (!user) throw new Error(`User not found: "${target}" (tried cache + guild member search)`);
      await user.send(message);
      return 'Message sent to user ' + (user.username || user.id);
    } else if (targetType === 'channel') {
      let channel = null;
      const channelName = target.replace(/^#/, '');
      if (/^\d+$/.test(channelName)) {
        channel = client.channels.cache.get(channelName);
      } else {
        channel = client.channels.cache.find(c => c.name === channelName);
      }
      if (!channel) throw new Error('Channel not found: ' + channelName);
      await channel.send(message);
      return 'Message sent to channel ' + (channel.name || channel.id);
    } else {
      throw new Error('Invalid targetType: ' + targetType);
    }
  } catch (err) {
    logger.error('sendDiscordMessage error:', err.message);
    throw err;
  }
}

/**
 * Determines if the bot should respond to a message in a guild channel.
 * - If only one non-bot user (besides the bot) is present, respond to all messages.
 * - If multiple users, only respond if the bot is mentioned.
 * In DMs, always respond.
 * @param {Discord.Message} message - The Discord.js message object
 * @param {Discord.Client} client - The Discord.js client (for bot user id)
 * @returns {boolean|Promise<boolean>}
 */
async function shouldRespondToMessage(message, client) {
  // Always respond in DMs
  if (message.channel.type === 1 || message.channel.type === 'DM') return true;

  // Guild text channels
  if (message.guild && message.channel && message.channel.members) {
    // message.channel.members is a Collection of GuildMembers who can view the channel
    const nonBotMembers = message.channel.members.filter(m => !m.user.bot && m.id !== client.user.id);
    if (nonBotMembers.size === 1) {
      return true;
    }
    // Otherwise, require mention
    return message.mentions.has(client.user);
  }

  // Threads (thread.members is a manager, need to fetch)
  if (message.channel.isThread && message.channel.members && typeof message.channel.members.fetch === 'function') {
    try {
      const threadMembers = await message.channel.members.fetch();
      const nonBotMembers = threadMembers.filter(m => !m.user.bot && m.id !== client.user.id);
      if (nonBotMembers.size === 1) {
        return true;
      }
      return message.mentions.has(client.user);
    } catch (e) {
      // Fallback: require mention
      return message.mentions.has(client.user);
    }
  }

  // Fallback: require mention
  return message.mentions.has(client.user);
}

module.exports = { 
  startDiscordHandler, 
  sendMessage, 
  sendDiscordMessage,
  getLastMessages,
  formatMessageHistory,
  buildContextWithHistory,
  shouldRespondToMessage,
  sendStatusUpdate,  // Export for use in prompt.js
  sendDiscordReasoning  // Export for use in prompt.js
};
