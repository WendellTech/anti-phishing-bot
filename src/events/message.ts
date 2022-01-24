import {ActionKind} from '@prisma/client';
import {PermissionFlagsBits} from 'discord-api-types';
import {Message, Permissions} from 'discord.js';
import {Event} from 'fish';

export class MessageCreateEvent extends Event {
  name = 'messageCreate';

  async run(msg: Message) {
    const {content, member} = msg;

    if (
      !member ||
      msg.author.bot ||
      msg.channel.type === 'DM' ||
      (await msg.client.db.exemptions.isExempt(msg.member!))
    ) {
      return;
    }

    const m = await this.client.services.domainManager.test(content);
    const matches = m.filter(m => m.isKnown);

    if (!matches.length) {
      return;
    }

    for (const {domain, isRedir} of matches) {
      this.client.metrics.addDomainHit(domain, isRedir);
    }

    const hitDomain = matches[0].domain;

    const guildConfig = await msg.client.db.guildConfigs.get(msg.guild!.id);

    const actionsTaken: string[] = [];
    const actionsFailed: string[] = [];
    try {
      if (guildConfig) {
        if (guildConfig.notify) {
          try {
            const actions: string[] = [];

            if (guildConfig.delete) {
              actions.push('DELETE');
            }

            if (guildConfig.action !== ActionKind.NONE) {
              actions.push(guildConfig.action);
            }

            await msg.member?.send({
              content: `Phishing link detected in **${
                msg.guild!.name
              }**. Actions taken: ${actions
                .map(a => `\`${a}\``)
                .join(', ')}\n> \`${hitDomain}\``,
            });
          } catch {
            //
          }
        }

        if (guildConfig.delete) {
          try {
            await msg.delete();
            actionsTaken.push('DELETE');
          } catch {
            actionsFailed.push('DELETE');
          }
        }

        switch (guildConfig.action) {
          case 'NONE':
            break;

          case 'BAN': {
            if (msg.member!.bannable) {
              await msg.member!.ban({
                reason: `Posted a phishing URL: ${hitDomain}`,
              });
              actionsTaken.push('BAN');
            } else {
              actionsFailed.push('BAN');
            }

            break;
          }

          case 'SOFTBAN': {
            if (msg.member!.bannable) {
              await msg.member!.ban({
                reason: `[SOFTBAN] Posted a phishing URL: ${hitDomain}`,
                days: 1,
              });

              await msg.guild!.members.unban(
                msg.author.id,
                `[SOFTBAN] Posted a phishing URL: ${hitDomain}`
              );

              actionsTaken.push('SOFTBAN');
            } else {
              actionsFailed.push('SOFTBAN');
            }

            break;
          }

          case 'MUTE': {
            if (!guildConfig.muteRole) {
              actionsFailed.push('MUTE');
              break;
            }

            try {
              await msg.member!.roles.add(guildConfig.muteRole);
              actionsTaken.push('MUTE');
            } catch {
              actionsFailed.push('MUTE');
            }
            break;
          }

          case 'KICK': {
            if (msg.member!.kickable) {
              await msg.member!.kick(`Posted a phishing URL: ${hitDomain}`);
              actionsTaken.push('KICK');
            } else {
              actionsFailed.push('KICK');
            }

            break;
          }

          case 'TIMEOUT': {
            try {
              await msg.member!.timeout(
                Number(guildConfig.timeoutDuration),
                `Posted a phishing URL: ${hitDomain}`
              );
              actionsTaken.push('TIMEOUT');
            } catch {
              actionsFailed.push('TIMEOUT');
            }

            break;
          }
        }

        await this.client.logger.action(
          msg.guild!.id,
          msg.author,
          hitDomain,
          actionsTaken,
          actionsFailed
        );
      } else {
        await msg.client.db.guildConfigs.add(msg.guild!.id);
        // no config = create config & delete
        await msg.delete();
      }
    } catch (e) {
      console.error(e);
    }
  }
}
