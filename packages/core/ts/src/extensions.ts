// Extension port — server-side mirror of the chativa ExtensionRegistry
// (same name, same philosophy: apply in order, null = block).
//
// Extensions observe/transform inbound user messages and outbound events, and
// hook conversation/connection lifecycle. Use them for telemetry and tracing
// (e.g. forwarding tool_call timings to LangSmith/OpenTelemetry), rate
// limiting, PII masking, persona injection, auth enrichment, ...

import type { AgentEvent } from "./events.js";
import type { IncomingMessage } from "./protocol.js";
import type { ConversationContext, TurnContext } from "./runtime.js";

export interface ConnectionInfo {
    connectionId: string;
}

export interface Extension {
    name: string;
    /** Inbound user message. Return a (possibly transformed) message, or null to swallow it. */
    onMessage?(
        msg: IncomingMessage,
        ctx: TurnContext,
    ): IncomingMessage | null | Promise<IncomingMessage | null>;
    /** Outbound event. Return a (possibly transformed) event, or null to drop it. */
    onEvent?(ev: AgentEvent, ctx: TurnContext): AgentEvent | null | Promise<AgentEvent | null>;
    /** First time a conversation is created. */
    onConversationStart?(ctx: ConversationContext): void | Promise<void>;
    /** Last live connection of the conversation detached (state is kept — it can resume). */
    onConversationEnd?(ctx: ConversationContext): void | Promise<void>;
    /** A connection attached to the conversation. */
    onConnect?(info: ConnectionInfo, ctx: ConversationContext): void | Promise<void>;
    /** A connection detached. */
    onDisconnect?(info: ConnectionInfo, ctx: ConversationContext): void | Promise<void>;
}

export class ExtensionRegistry {
    constructor(public readonly extensions: Extension[] = []) {}

    register(extension: Extension): void {
        this.extensions.push(extension);
    }

    /** Run the inbound message through the chain; null once any extension swallows it. */
    async applyMessage(msg: IncomingMessage, ctx: TurnContext): Promise<IncomingMessage | null> {
        let current: IncomingMessage | null = msg;
        for (const ext of this.extensions) {
            if (!ext.onMessage || current === null) continue;
            current = await ext.onMessage(current, ctx);
            if (current == null) return null;
        }
        return current;
    }

    /** Run the outbound event through the chain; null = do not send. */
    async applyEvent(ev: AgentEvent, ctx: TurnContext): Promise<AgentEvent | null> {
        let current: AgentEvent | null = ev;
        for (const ext of this.extensions) {
            if (!ext.onEvent || current === null) continue;
            current = await ext.onEvent(current, ctx);
            if (current == null) return null;
        }
        return current;
    }

    async notifyConversationStart(ctx: ConversationContext): Promise<void> {
        for (const ext of this.extensions) await ext.onConversationStart?.(ctx);
    }

    async notifyConversationEnd(ctx: ConversationContext): Promise<void> {
        for (const ext of this.extensions) await ext.onConversationEnd?.(ctx);
    }

    async notifyConnect(info: ConnectionInfo, ctx: ConversationContext): Promise<void> {
        for (const ext of this.extensions) await ext.onConnect?.(info, ctx);
    }

    async notifyDisconnect(info: ConnectionInfo, ctx: ConversationContext): Promise<void> {
        for (const ext of this.extensions) await ext.onDisconnect?.(info, ctx);
    }
}
