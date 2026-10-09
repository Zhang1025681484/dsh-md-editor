/**
 * dsh-md-editor —— 宿主半（Host plugin）。
 *
 * 两件事：
 *   1. 用 `ctx.connection.fetch.register` 暴露 Monaco 0.52.2 的静态资源
 *      （同源、无 CDN、断网可用），路径 `/api/md-editor/monaco`。
 *   2. 注册 `/md-save` 命令，供浏览器半把编辑内容写回磁盘，并支持版本冲突保护。
 *
 * 为什么写入必须走宿主：
 *   浏览器侧唯一可用的文件服务 `remote.workspaceFiles` 只有读操作
 *   （官方文档：「本服务不提供修改操作」），而客户端 Remote 命名空间是构建期固定装配的，
 *   外部插件无法在运行时新增命名空间。因此写入只能由宿主执行。
 *
 * 为什么不用 `import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'`：
 *   profile 安装的插件经 junction/symlink 引入，Node 从真实路径解析依赖，
 *   而 DSH 的包位于 app.asar 内，解析不到（ERR_MODULE_NOT_FOUND）。
 *   本插件只依赖 Cordis 服务（`ctx.connection`、`ctx.commands`、`ctx.fs`）与 Node 内置模块。
 *
 * 命令约定：
 *   `/md-save <base64(JSON.stringify({ path, content, expected? }))>`
 *   —— base64 是为了在单行命令里安全传递任意 UTF-8 文本（含换行）；
 *   `recordInput: false` 避免整份正文写进会话日志的 `command/run` 事件；
 *   `expected` 是读取时拿到的文件版本，带上它即启用冲突保护。
 *
 * Monaco 资源投递与安全校验（monaco.js）复用自 yueyexiayu/dsh-bianji（MIT），
 * 已把路由与插件目录计算改为本插件；详见 README 的「代码来源」。
 */

import { handleMonacoRequest, MONACO_ROUTE } from "./monaco.js";

/** 需要 connection（资源路由）、commands（保存命令）、fs（写盘） */
export const inject = ["connection", "commands", "fs"];

/** 命令名，浏览器半必须用同一个名字 */
const COMMAND_NAME = "md-save";

function ok(text) {
  return { kind: "success", text };
}
function fail(text) {
  return { kind: "error", text };
}

/** 从异常里取出最有用的一句话（优先结构化错误码） */
function reasonOf(error) {
  if (!error) return "未知错误";
  const code = error && error.code ? String(error.code) : "";
  const message = error && error.message ? String(error.message) : String(error);
  return code ? code + ": " + message : message;
}

/** 会话作用域优先取服务（沙箱策略按会话解析），取不到再退回插件 ctx */
function pick(agent, ctx, serviceName) {
  try {
    const fromAgent =
      agent && agent.ctx && typeof agent.ctx.get === "function" ? agent.ctx.get(serviceName) : undefined;
    if (fromAgent) return fromAgent;
  } catch {
    /* 服务不存在时忽略 */
  }
  try {
    return ctx.get(serviceName);
  } catch {
    return undefined;
  }
}

export function apply(ctx) {
  // ---- 1. Monaco 静态资源路由 ----
  const connection = ctx.connection;
  if (connection && connection.fetch && typeof connection.fetch.register === "function") {
    try {
      connection.fetch.register({
        path: MONACO_ROUTE,
        methods: ["GET"],
        requestBody: "buffered",
        fetch: (request) => handleMonacoRequest(request),
      });
    } catch (error) {
      console.error("[md-editor] Monaco 资源路由注册失败：" + reasonOf(error));
    }
  }

  // ---- 2. 自检信标：客户端半每次加载/注册都会往插件目录落一行日志 ----
  // 目的：客户端 bundle 是惰性的、控制台日志会被刷新清空，落盘才能事后确认。
  if (connection && connection.fetch && typeof connection.fetch.register === "function") {
    try {
      connection.fetch.register({
        path: "/api/md-editor/beacon",
        methods: ["GET"],
        requestBody: "buffered",
        fetch: async (request) => {
          try {
            const stage = new URL(request.url).searchParams.get("stage") || "unknown";
            const fsp = await import("node:fs/promises");
            const nodePath = await import("node:path");
            const { fileURLToPath } = await import("node:url");
            const dir = nodePath.dirname(fileURLToPath(import.meta.url));
            await fsp.appendFile(
              nodePath.join(dir, ".client-beacon.log"),
              new Date().toISOString() + " " + stage + "\n",
              "utf8"
            );
          } catch {
            /* 落盘失败不影响响应 */
          }
          return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
        },
      });
    } catch (error) {
      console.error("[md-editor] beacon 路由注册失败：" + reasonOf(error));
    }
  }

  // ---- 3. /md-save 保存命令 ----
  const commands = ctx.commands;
  if (!commands || typeof commands.register !== "function") return;

  ctx.effect(
    () =>
      commands.register({
        name: COMMAND_NAME,
        description: "把 Markdown 编辑器提交的内容写回磁盘（由 dsh-md-editor 使用）",
        input: { hint: "<base64 载荷>" },
        recordInput: false,
        handler: async ({ agent, rawInput }) => {
          const fileSystem = pick(agent, ctx, "fs");
          if (!fileSystem || typeof fileSystem.writeText !== "function") {
            return fail("宿主文件系统服务不可用");
          }

          let payload;
          try {
            const encoded = String(rawInput || "").trim();
            if (!encoded) return fail("缺少载荷");
            payload = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
          } catch (error) {
            return fail("载荷无法解析：" + reasonOf(error));
          }

          const target = payload && typeof payload.path === "string" ? payload.path : undefined;
          const content = payload && typeof payload.content === "string" ? payload.content : undefined;
          const expected =
            payload && typeof payload.expected === "string" && payload.expected ? payload.expected : undefined;
          if (!target) return fail("载荷缺少 path");
          if (content === undefined) return fail("载荷缺少 content");

          try {
            // 关键：客户端给的是工作区相对路径（如 方案/README.md），
            // resolve 的 cwd 必须显式给出会话工作区，否则会被解析到 DSH 进程的 cwd，
            // 结果"写入成功"但目标文件纹丝不动（实测：磁盘 9382 字节未变，
            // 而返回的 version 已是新 inode + 新 size）。
            let workspaceCwd;
            try {
              const session = agent && agent.session;
              if (session && session.header && typeof session.header.cwd === "string" && session.header.cwd) {
                workspaceCwd = session.header.cwd;
              } else if (session && typeof session.requestHeader === "function") {
                const header = session.requestHeader();
                if (header && typeof header.cwd === "string" && header.cwd) workspaceCwd = header.cwd;
              }
            } catch {
              /* 拿不到就退回不传 cwd（旧行为） */
            }
            const resolved = await fileSystem.resolve(target, workspaceCwd ? { cwd: workspaceCwd } : {});

            let policy;
            try {
              const sandboxPolicy = pick(agent, ctx, "sandboxPolicy");
              if (sandboxPolicy && typeof sandboxPolicy.resolve === "function") {
                policy = sandboxPolicy.resolve({ session: agent && agent.session });
              }
            } catch {
              /* 策略服务可选 */
            }

            // 有 expected 时走版本防护：文件被外部改过会以 FS_STALE_VERSION 拒绝，
            // 而不是静默覆盖。签名：writeText(target, content, guard, signal, policy)
            const guard = expected ? { kind: "replaceIfVersion", version: expected } : undefined;
            const outcome = await fileSystem.writeText(resolved, content, guard, undefined, policy);

            const version = outcome && outcome.version ? String(outcome.version) : "";
            return ok(version ? "已保存（版本 " + version + "）" : "已保存");
          } catch (error) {
            const code = error && error.code;
            if (code === "FS_STALE_VERSION") {
              // 把两个版本号都报出来，便于判断是"真被外部改了"还是"版本取值不对"。
              // fs 的 version 构成：dev:ino:size:mtimeNs:ctimeNs
              let actual = "";
              try {
                const currentTarget = await fileSystem.resolve(target, {});
                const currentStat = await fileSystem.stat(currentTarget);
                actual = currentStat && currentStat.version ? String(currentStat.version) : "";
              } catch {
                /* 拿不到就只报期望值 */
              }
              return fail(
                "版本冲突，已阻止覆盖。期望[" + String(expected || "空") + "] 实际[" + (actual || "未知") + "]"
              );
            }
            if (code === "FS_SANDBOX_DENIED") return fail("当前会话权限不允许保存");
            if (code === "FS_NOT_TEXT") return fail("内容不是合法文本，已拒绝写入");
            return fail(reasonOf(error));
          }
        },
      }),
    "md-editor: /md-save command"
  );
}
