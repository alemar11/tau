import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ClientError } from "../../src/client/client.ts";
import type { PiRuntime } from "./runtime.ts";
import { RenderBlock, renderTool } from "./ui/render.ts";

export function registerTools(pi: ExtensionAPI, current: () => PiRuntime | undefined): void {
  pi.registerTool({
    name: "openspace", label: "Openspace", defaultActive: true, exposure: "direct",
    description: "List local Pi peers, inspect or change your status note, send text/attachments, or request cancellation. One shared workgroup per send; select it when ambiguous. Delivery/receipt is not task completion. Files are textual attachments, not remote filesystem access. Use ask only when blocked on information; it waits for one correlated reply, not task completion. Reply to a pending ask or inspect pending. Timeout does not cancel remote work. Remote/pane operations are not available.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("list-cwd"), Type.Literal("status"), Type.Literal("send"), Type.Literal("cancel"), Type.Literal("ask"), Type.Literal("reply"), Type.Literal("pending")]),
      to: Type.Optional(Type.String()), cwd: Type.Optional(Type.String()), workgroup: Type.Optional(Type.String()),
      text: Type.Optional(Type.String()), messageId: Type.Optional(Type.String()), supersedes: Type.Optional(Type.String()), retryOf: Type.Optional(Type.String()),
      replyTo: Type.Optional(Type.Object({ workgroup: Type.String(), senderId: Type.String(), messageId: Type.String() })),
      note: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      attachments: Type.Optional(Type.Array(Type.Object({ type: Type.Union([Type.Literal("file"), Type.Literal("snippet"), Type.Literal("context")]),
        name: Type.String(), text: Type.String(), language: Type.Optional(Type.String()) }), { maxItems: 32 })),
    }),
    renderCall: (args, theme) => new RenderBlock(`Openspace ${args.action ?? "…"}${args.to ? ` → ${args.to}` : ""}${args.workgroup ? ` [${args.workgroup}]` : ""}`, "", theme),
    renderResult: (result, options, theme, context) => renderTool(result.details, options.expanded, theme, context.isError),
    async execute(_id, params, signal, _update, ctx) {
      const runtime = current();
      try {
        if (!runtime) throw new ClientError("openspace_disabled");
        await runtime.ready(ctx);
        if (signal?.aborted) throw new ClientError("aborted");
        let details: unknown;
        if (params.action === "pending") {
          details = { pending: runtime.conversation.pending() };
        } else if (params.action === "ask") {
          const result = await runtime.ask(params.to, { ...params, text: params.text ?? "", signal });
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: result, ...(result.status === "failed" ? { isError: true } : {}) };
        } else if (params.action === "reply") {
          const result = await runtime.reply(params, { ...params, text: params.text ?? "", signal });
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: result,
            ...(result.delivery === "failed" || result.delivery === "unknown" ? { isError: true } : {}) };
        } else if (params.action === "list" || params.action === "list-cwd") {
          details = { sessions: await runtime.client.listSessions({ workgroup: params.workgroup,
            ...(params.action === "list-cwd" ? { cwd: params.cwd ?? ctx.cwd } : {}) }) };
        } else if (params.action === "status") {
          if (params.note !== undefined) await runtime.setNote(params.note);
          details = { session: runtime.client.info };
        } else if (params.action === "cancel") {
          if (!params.workgroup || !params.messageId) throw new ClientError("cancel_requires_workgroup_and_messageId");
          details = await runtime.messenger.cancel({ workgroup: params.workgroup, senderId: runtime.client.info!.id, messageId: params.messageId });
        } else {
          const result = await runtime.send(params.to, { ...params, text: params.text ?? "", signal });
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: result,
            ...(result.delivery === "failed" || result.delivery === "unknown" ? { isError: true } : {}) };
        }
        runtime.assertCurrent(ctx);
        return { content: [{ type: "text", text: JSON.stringify(details) }], details };
      } catch (error) {
        const details = { error: error instanceof Error ? error.message : "openspace_error", code: typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "openspace_error",
          ...(runtime?.client.info ? { currentWorkgroups: runtime.client.info.workgroups } : {}) };
        return { content: [{ type: "text", text: JSON.stringify(details) }], details, isError: true };
      }
    },
  });
}
