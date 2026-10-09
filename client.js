/**
 * dsh-md-editor —— 浏览器半（Client UI plugin）。
 *
 * 目标：在**官方工作区文件树**里点开一个 .md，就在**官方右栏的文档标签内**直接编辑并保存，
 *      不需要切到别的页面。官方保留标签、路径头、刷新、主题等全部原生行为。
 *
 * 接管方式（第二层：文档渲染器，依据 dsh-client-ui-sidebar-documentpreview 的 README）：
 *   ctx.documentPreviews.register({ id, extensions, priority, title, loading, wrap? })
 *   并以同一 id 向 keyed slot `sidebar.right.tab.document` 注册正文。
 *   - priority 'extension' 是默认档也是最高档 → 优先于官方 markdown 渲染器（builtin）。
 *   - loading: 'renderer' → 正文在读取任何字节前挂载，内容加载/错误/取消全部由本组件负责；
 *     官方只提供 `content: { kind:'renderer', revision, loaded, failed, reload }` 协作接口。
 *   - 官方自带"渲染器下拉菜单"：用户可随时切回官方 Markdown（md-studio 的增强预览仍在），
 *     所以本插件与 dsh-md-studio 可以共存，不是二选一。
 *
 * 正文收到的 props：resourceAddress、content、wrap、scrollportRef、addResource、setResources
 *                  以及标准 useTabInfo / useResource 钩子。
 *
 * 硬约束（官方文档明说，违反会让界面坏）：
 *   - 不能 require 任何 DSH 客户端包；控件与样式全部自写；
 *   - 组件抛错会让整个 slot 条目白屏 → 这里包了错误边界与全量 try/catch；
 *   - 只用 --dsw-alias-* 主题变量取色。
 *
 * Monaco 加载机制复用自 yueyexiayu/dsh-bianji（MIT），路由前缀已改为本插件。
 */

window.__ModuleLoader__.load({
  id: 'dsh-md-editor',
  factory(require) {
    // 自检标记：在浏览器控制台输入 window.__dshMdEditor 即可确认
    // 客户端半是否被加载（undefined = 没加载）、渲染器是否注册成功。
    window.__dshMdEditor = { loaded: true, registered: false, error: null };
    // 落盘信标：客户端 bundle 是惰性的、控制台日志会被刷新清空，
    // 因此主动告诉 Host 半"我加载了"，便于事后在磁盘上确认。
    try {
      fetch('/api/md-editor/beacon?stage=client-loaded', { credentials: 'same-origin' }).catch(function () {});
    } catch (beaconError) {
      /* 信标失败不影响插件 */
    }
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    /** 渲染器身份：同时作为正文 slot 的 key 与 documentPreviews 的 id */
    const RENDERER_ID = 'dsh-md-editor';
    const MONACO_BASE = '/api/md-editor/monaco?file=vs';
    const SAVE_COMMAND = 'md-save';
    const PAGE_LINES = 5000;
    const MAX_PAGES = 40;
    const AUTOSAVE_MS = 1500; // 自动保存：停止编辑 1.5 秒后写盘

    // ============================================================ 基础工具

    function toBase64Utf8(text) {
      const bytes = new TextEncoder().encode(text);
      let binary = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      return btoa(binary);
    }

    /** dsh-resource://file/session/<sessionId>/<path> —— path 可能是绝对路径，保留原样 */
    function parseFileAddress(address) {
      if (typeof address !== 'string') return undefined;
      const match = /^dsh-resource:\/\/file\/session\/([^/]+)\/([\s\S]*)$/.exec(address);
      if (!match) return undefined;
      try {
        return { sessionId: decodeURIComponent(match[1]), path: decodeURIComponent(match[2]) };
      } catch {
        return { sessionId: match[1], path: match[2] };
      }
    }

    /** 落盘信标：没有控制台可查时，用它把关键阶段写进宿主日志 */
    function beacon(stage) {
      try {
        fetch('/api/md-editor/beacon?stage=' + encodeURIComponent(String(stage)), {
          credentials: 'same-origin',
        }).catch(function () {});
      } catch (beaconError) {
        /* 信标失败不影响插件 */
      }
    }

    function reasonOf(error) {
      if (!error) return '未知错误';
      if (typeof error === 'string') return error;
      const code = error.code ? String(error.code) : '';
      const message = error.message ? String(error.message) : JSON.stringify(error);
      return code ? code + ': ' + message : message;
    }

    function isDarkTheme() {
      try {
        return (
          document.body.hasAttribute('data-ds-dark-theme') ||
          document.documentElement.dataset.theme === 'dark'
        );
      } catch {
        return false;
      }
    }

    // ============================================================ Monaco 加载
    // 说明：Monaco 0.52.2 的 AMD loader 在 paths.vs 含 "?" 时会丢掉 ".js"，
    // 因此这里自己 fetch 同源资源、用 blob URL 执行，并劫持 head.appendChild。
    let monacoLoading = null;

    function monacoUnavailable() {
      return new Error('monaco unavailable');
    }

    function fetchMonaco(url, expectJs) {
      return fetch(url, { credentials: 'same-origin' }).then((res) => {
        if (!res || !res.ok || typeof res.text !== 'function') throw monacoUnavailable();
        if (expectJs) {
          const type = res.headers && res.headers.get ? res.headers.get('content-type') || '' : '';
          if (type.indexOf('javascript') < 0) throw monacoUnavailable();
        }
        return res.text();
      });
    }

    function loadScriptText(text) {
      return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
        const el = document.createElement('script');
        let done = false;
        const timeout = setTimeout(fail, 15000);
        function clean() {
          clearTimeout(timeout);
          el.onload = null;
          el.onerror = null;
          try {
            URL.revokeObjectURL(url);
          } catch {
            /* ignore */
          }
        }
        function fail() {
          if (done) return;
          done = true;
          clean();
          try {
            el.remove();
          } catch {
            /* ignore */
          }
          reject(monacoUnavailable());
        }
        el.async = true;
        el.src = url;
        el.onload = () => {
          if (done) return;
          done = true;
          clean();
          resolve();
        };
        el.onerror = fail;
        (document.head || document.getElementsByTagName('head')[0]).appendChild(el);
      });
    }

    function monacoFileFromUrl(src) {
      const marker = '?file=';
      const at = String(src).indexOf(marker);
      if (at < 0) throw monacoUnavailable();
      let file = String(src).slice(at + marker.length);
      const cut = file.search(/[&#]/);
      if (cut >= 0) file = file.slice(0, cut);
      try {
        file = decodeURIComponent(file);
      } catch {
        throw monacoUnavailable();
      }
      if (!file || file.indexOf('..') >= 0 || file.indexOf('\\') >= 0 || file.indexOf('\0') >= 0 || file.charAt(0) === '/') {
        throw monacoUnavailable();
      }
      if (!/\.(js|css|ttf|json)$/i.test(file)) file += '.js';
      return file;
    }

    function installMonacoScriptBridge() {
      if (installMonacoScriptBridge.done) return;
      const head = document.head || document.getElementsByTagName('head')[0];
      if (!head || !head.appendChild) return;
      installMonacoScriptBridge.done = true;
      const orig = head.appendChild.bind(head);
      head.appendChild = function (node) {
        const src = node && node.getAttribute ? node.getAttribute('src') || '' : '';
        if (!node || String(node.tagName || '').toUpperCase() !== 'SCRIPT' || src.indexOf('/api/md-editor/monaco?file=') !== 0) {
          return orig(node);
        }
        let file;
        try {
          file = monacoFileFromUrl(src);
        } catch {
          try {
            node.dispatchEvent(new Event('error'));
          } catch {
            /* ignore */
          }
          return node;
        }
        fetchMonaco('/api/md-editor/monaco?file=' + file, true)
          .then((text) => {
            const blobUrl = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
            const drop = () => {
              try {
                URL.revokeObjectURL(blobUrl);
              } catch {
                /* ignore */
              }
            };
            node.addEventListener('load', drop);
            node.addEventListener('error', drop);
            node.setAttribute('src', blobUrl);
            orig(node);
          })
          .catch(() => {
            try {
              node.dispatchEvent(new Event('error'));
            } catch {
              /* ignore */
            }
          });
        return node;
      };
    }

    function rewriteMonacoCss(css) {
      const base = ['vs', 'editor'];
      return String(css).replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (full, _quote, raw) => {
        const value = String(raw).trim();
        if (!value || /^(?:data:|https?:|blob:|#|\/)/i.test(value)) return full;
        const parts = base.slice();
        for (const piece of value.split('/')) {
          if (!piece || piece === '.') continue;
          if (piece === '..') parts.pop();
          else parts.push(piece);
        }
        if (!parts.length || parts[0] !== 'vs' || parts.indexOf('..') >= 0) return full;
        return 'url("/api/md-editor/monaco?file=' + parts.join('/') + '")';
      });
    }

    function injectMonacoCss(css) {
      const id = 'md-editor-monaco-css';
      const text = rewriteMonacoCss(css);
      const existing = document.getElementById(id);
      if (existing) {
        existing.textContent = text;
        return;
      }
      const style = document.createElement('style');
      style.id = id;
      style.textContent = text;
      (document.head || document.getElementsByTagName('head')[0]).appendChild(style);
    }

    function installMonacoWorkers() {
      const base = '/api/md-editor/monaco?file=';
      const workerFile = base + 'vs/base/worker/workerMain.js';
      window.MonacoEnvironment = {
        getWorker(_workerId, label) {
          const source =
            'globalThis.MonacoEnvironment={baseUrl:' +
            JSON.stringify(base) +
            '};importScripts(' +
            JSON.stringify(workerFile) +
            ');';
          return new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })), { name: label });
        },
      };
    }

    function requireEditorMain() {
      return new Promise((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(monacoUnavailable());
        }, 15000);
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          if (error) reject(error);
          else resolve(value);
        };
        try {
          window.require(
            ['vs/editor/editor.main'],
            () => {
              if (!window.monaco || !window.monaco.editor) finish(monacoUnavailable());
              else finish(null, window.monaco);
            },
            () => finish(monacoUnavailable())
          );
        } catch (error) {
          finish(error);
        }
      });
    }

    function loadLocalMonaco() {
      installMonacoWorkers();
      return fetchMonaco(MONACO_BASE + '/loader.js', true)
        .then((text) => loadScriptText(text))
        .then(() => {
          if (!window.require || typeof window.require.config !== 'function') throw monacoUnavailable();
          window.require.config({ paths: { vs: MONACO_BASE }, 'vs/css': { disabled: true } });
          installMonacoScriptBridge();
          return fetchMonaco(MONACO_BASE + '/editor/editor.main.css', false);
        })
        .then((css) => {
          injectMonacoCss(css);
          return requireEditorMain();
        });
    }

    function ensureMonaco() {
      if (window.monaco && window.monaco.editor) return Promise.resolve(window.monaco);
      if (monacoLoading) return monacoLoading;
      monacoLoading = Promise.resolve()
        .then(loadLocalMonaco)
        .catch((error) => {
          monacoLoading = null;
          throw error;
        });
      return monacoLoading;
    }

    // ============================================================ 样式
    const S = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: '65vh',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        font: 'var(--dsw-font-xs-13)',
      },
      bar: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        flex: 'none',
        padding: '6px 8px',
        borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
      },
      path: {
        flex: 1,
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        color: 'var(--dsw-alias-label-tertiary)',
        font: '11px/16px var(--ds-font-family-code)',
      },
      button: {
        flex: 'none',
        border: '0.5px solid var(--dsw-alias-border-l2)',
        borderRadius: 'var(--dsw-radius-sm)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
        padding: '3px 9px',
        font: 'var(--dsw-font-xxs-12)',
      },
      buttonPrimary: {
        flex: 'none',
        border: '0.5px solid transparent',
        borderRadius: 'var(--dsw-radius-sm)',
        background: 'var(--dsw-alias-state-business-primary)',
        color: '#fff',
        cursor: 'pointer',
        padding: '3px 9px',
        font: 'var(--dsw-font-xxs-12)',
      },
      editorHost: { flex: 1, minHeight: '300px', position: 'relative', overflow: 'hidden' },
      status: {
        flex: 'none',
        minHeight: '20px',
        padding: '3px 8px',
        borderTop: '0.5px solid var(--dsw-alias-border-l2)',
        color: 'var(--dsw-alias-label-tertiary)',
        font: 'var(--dsw-font-xxs-12)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      statusError: {
        flex: 'none',
        minHeight: '20px',
        padding: '3px 8px',
        borderTop: '0.5px solid var(--dsw-alias-border-l2)',
        color: 'var(--dsw-alias-state-error-primary)',
        font: 'var(--dsw-font-xxs-12)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      fallbackWrap: { display: 'flex', height: '100%', minHeight: 0 },
      gutter: {
        flex: 'none',
        padding: '10px 6px 10px 10px',
        textAlign: 'right',
        color: 'var(--dsw-alias-label-tertiary)',
        background: 'var(--dsw-alias-bg-base)',
        font: '12px/19px var(--ds-font-family-code)',
        userSelect: 'none',
        overflow: 'hidden',
      },
      textarea: {
        flex: 1,
        minWidth: 0,
        resize: 'none',
        border: 0,
        outline: 'none',
        padding: '10px 12px 10px 0',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        font: '12px/19px var(--ds-font-family-code)',
        tabSize: 2,
      },
    };

    // ============================================================ 错误边界
    class Boundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: undefined };
      }
      static getDerivedStateFromError(error) {
        return { error };
      }
      render() {
        if (this.state.error) {
          return h(
            'div',
            { style: { ...S.statusError, borderTop: 0, padding: '10px 12px', whiteSpace: 'pre-wrap' } },
            'Markdown 编辑器出错：' + reasonOf(this.state.error)
          );
        }
        return this.props.children;
      }
    }

    // ============================================================ 降级编辑器
    function LinedTextarea({ value, onChange, inputRef }) {
      const lines = String(value || '').split('\n').length;
      const nums = [];
      for (let i = 1; i <= lines; i += 1) nums.push(i + '\n');
      return h(
        'div',
        { style: S.fallbackWrap },
        h('div', { style: S.gutter }, nums.join('')),
        h('textarea', {
          ref: inputRef,
          style: S.textarea,
          value,
          spellCheck: false,
          onChange: (event) => onChange(event.target.value),
        })
      );
    }

    // ============================================================ Monaco 组件
    function MonacoEditor({ value, onChange }) {
      const hostRef = useRef(null);
      const editorRef = useRef(null);
      const changeRef = useRef(onChange);
      changeRef.current = onChange;
      const [failed, setFailed] = useState(false);
      const [ready, setReady] = useState(false);

      useEffect(() => {
        let disposed = false;
        let editor;
        beacon('monaco-ensure-start');
        ensureMonaco()
          .then((monaco) => {
            if (disposed || !hostRef.current) {
              beacon('monaco-host-missing disposed=' + String(disposed) + ' host=' + String(Boolean(hostRef.current)));
              return;
            }
            editor = monaco.editor.create(hostRef.current, {
              value: value,
              language: 'markdown',
              theme: isDarkTheme() ? 'vs-dark' : 'vs',
              automaticLayout: true,
              minimap: { enabled: false },
              fontSize: 13,
              lineNumbers: 'on',
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              renderWhitespace: 'none',
              tabSize: 2,
            });
            editorRef.current = editor;
            editor.onDidChangeModelContent(() => {
              changeRef.current(editor.getValue());
            });
            setReady(true);
            // 记录实际尺寸与 DOM 状态：Monaco 创建成功但界面不对，通常是 CSS 未注入
            beacon(
              'monaco-ready hostH=' +
                String(hostRef.current ? hostRef.current.clientHeight : -1) +
                ' hostW=' +
                String(hostRef.current ? hostRef.current.clientWidth : -1) +
                ' parentH=' +
                String(hostRef.current && hostRef.current.parentElement ? hostRef.current.parentElement.clientHeight : -1) +
                ' monacoDom=' +
                String(Boolean(document.querySelector('.monaco-editor'))) +
                ' lineNumbers=' +
                String(document.querySelectorAll('.line-numbers').length) +
                ' monacoStyles=' +
                String(document.querySelectorAll('style[id*="monaco"]').length) +
                ' anyStyle=' +
                String(document.querySelectorAll('style').length)
            );
          })
          .catch((monacoError) => {
            beacon('monaco-failed ' + reasonOf(monacoError));
            if (!disposed) setFailed(true);
          });
        return () => {
          disposed = true;
          try {
            if (editor) editor.dispose();
          } catch {
            /* ignore */
          }
          editorRef.current = null;
        };
        // 只在挂载时创建一次；后续 value 变化走下面的同步 effect
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      // 外部重新加载（reload）后把新内容灌回编辑器，且不触发 onChange 递归
      useEffect(() => {
        const editor = editorRef.current;
        if (!editor) return;
        try {
          if (editor.getValue() !== value) editor.setValue(value);
        } catch {
          /* ignore */
        }
      }, [value, ready]);

      if (failed) return h(LinedTextarea, { value, onChange });
      return h('div', { ref: hostRef, style: { position: 'absolute', inset: 0 } });
    }

    /** 服务获取：直接属性优先，其次 Cordis 的 ctx.get()
     *  （documentPreviews 只能走后者 —— 直接属性取不到） */
    function pickService(ctx, name) {
      try {
        const direct = ctx[name];
        if (direct) return direct;
      } catch {
        /* 某些 ctx 上属性访问会抛错 */
      }
      try {
        if (typeof ctx.get === 'function') return ctx.get(name);
      } catch {
        /* ignore */
      }
      return undefined;
    }

    // ============================================================ 正文组件
    function createBody(ctx) {
      return function MdEditorBody(props) {
        // 第一层（自己的标签类型）：正文用标准 useTabInfo 钩子取当前标签的资源地址
        const tabInfo = props && typeof props.useTabInfo === 'function' ? props.useTabInfo() : undefined;
        const tab = tabInfo && tabInfo.tab ? tabInfo.tab : undefined;
        const resourceAddress = tab && tab.contentId;
        // 第一层没有官方的 content 协作对象；保留一个空 ref，
        // 让下面那些防御性调用（loaded/failed）自然跳过。
        const contentRef = useRef(undefined);

        const parsed = useMemo(() => parseFileAddress(resourceAddress), [resourceAddress]);

        const [text, setText] = useState('');
        const [original, setOriginal] = useState('');
        const [version, setVersion] = useState(undefined);
        const [phase, setPhase] = useState('loading'); // loading|ready|saving|saved|conflict|error
        const [message, setMessage] = useState('正在读取…');
        const [truncated, setTruncated] = useState(false);
        const alive = useRef(true);
        const saveTimer = useRef(null);
        const textRef = useRef('');
        textRef.current = text;

        const dirty = text !== original;

        useEffect(() => {
          alive.current = true;
          beacon('body-mount');
          return () => {
            alive.current = false;
            beacon('body-unmount');
            if (saveTimer.current) clearTimeout(saveTimer.current);
          };
        }, []);

        /** 读全文（分页），并记录版本 */
        const load = useCallback(
          async (signal) => {
            // 整个读取过程包一层兜底：任何同步异常都必须落盘，
            // 否则界面只会停在"正在读取…"，且日志里看不到后续阶段。
            try {
              beacon('load-start addr=' + String(resourceAddress || 'none'));
            if (!parsed) {
              beacon('parse-failed');
              setPhase('error');
              setMessage('无法从资源地址解析出文件路径');
              if (contentRef.current && contentRef.current.failed) contentRef.current.failed();
              return;
            }
            const remote = pickService(ctx, 'remote');
            // Cordis 的服务代理会在「访问属性」时才拒绝未 inject 的服务，因此这里也要兜住
            let api;
            try {
              api = remote && remote.workspaceFiles;
            } catch (accessError) {
              beacon('remote-access-denied ' + reasonOf(accessError));
            }
            beacon('service remote=' + (remote ? 'ok' : 'missing') + ' workspaceFiles=' + (api ? 'ok' : 'missing'));
            if (!api || typeof api.read !== 'function') {
              setPhase('error');
              setMessage('workspaceFiles 服务不可用');
              if (contentRef.current && contentRef.current.failed) contentRef.current.failed();
              return;
            }
            setPhase('loading');
            setMessage('正在读取…');
            setTruncated(false);
            try {
              const parts = [];
              let offset = 1;
              let pages = 0;
              let lastVersion;
              for (;;) {
                beacon('read-request offset=' + offset);
                const result = await api.read(parsed.sessionId, parsed.path, { offset, limit: PAGE_LINES }, signal);
                if (!result || result.ok !== true) {
                  beacon('read-failed ' + (result && result.error ? reasonOf(result.error) : 'no-result'));
                  throw new Error(result && result.error ? reasonOf(result.error) : '读取失败');
                }
                const page = result.value || {};
                if (page.version) lastVersion = page.version;
                parts.push(typeof page.text === 'string' ? page.text : '');
                pages += 1;
                if (page.eof) break;
                if (pages >= MAX_PAGES) {
                  if (alive.current) setTruncated(true);
                  break;
                }
                offset += PAGE_LINES;
              }
              const full = parts.join('\n');
              beacon('read-ok lines=' + full.split('\n').length + ' pages=' + pages);
              if (!alive.current) return;
              setText(full);
              setOriginal(full);
              setVersion(lastVersion);
              setPhase('ready');
              setMessage(truncated ? '已截断（文件过大）' : full.split('\n').length + ' 行');
              // 通知官方：已展示该版本（结束加载态）
              if (contentRef.current && contentRef.current.loaded) contentRef.current.loaded(lastVersion);
            } catch (error) {
              beacon(
                'read-error ' +
                  reasonOf(error) +
                  ' aborted=' +
                  String(Boolean(signal && signal.aborted)) +
                  ' alive=' +
                  String(alive.current)
              );
              if (!alive.current) return;
              setPhase('error');
              setMessage(reasonOf(error));
              if (contentRef.current && contentRef.current.failed) contentRef.current.failed();
            }
            } catch (fatal) {
              beacon('load-fatal ' + reasonOf(fatal) + ' | stack=' + String((fatal && fatal.stack) || '').slice(0, 300));
              if (alive.current) {
                setPhase('error');
                setMessage(reasonOf(fatal));
              }
            }
          },
          [parsed]
        );

        // 首次挂载（或资源地址变化）→ 读取一次；卸载时取消
        useEffect(() => {
          const controller = new AbortController();
          beacon('effect-run addr=' + String(resourceAddress || 'none'));
          load(controller.signal);
          const id = saveTimer.current;
          return () => {
            beacon('effect-cleanup-abort');
            controller.abort();
            if (id) clearTimeout(id);
          };
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [load]);

        /** 写回磁盘（经宿主 /md-save 命令，带版本冲突保护） */
        const save = useCallback(async () => {
          if (!parsed || phase === 'saving' || phase === 'loading') return;
          const remote = pickService(ctx, 'remote');
          let commands;
          try {
            commands = remote && remote.commands;
          } catch (accessError) {
            beacon('remote-commands-denied ' + reasonOf(accessError));
          }
          if (!commands || typeof commands.execute !== 'function') {
            setPhase('error');
            setMessage('commands 服务不可用');
            return;
          }
          const payloadText = textRef.current;
          setPhase('saving');
          setMessage('正在保存…');
          try {
            // 不传 expected（即不做 replaceIfVersion 版本校验）：
            // 实测 DSH 的 version 经 Remote 层传到浏览器后 mtimeNs 段会变形
            // （期望 1781482301616186400 vs 磁盘实际 1791482301616186400，差恰好 1e16），
            // 导致 replaceIfVersion 恒判冲突、正常保存被拒。
            // 需要以磁盘为准时用界面上的「重新读取」按钮。
            const payload = toBase64Utf8(
              JSON.stringify({ path: parsed.path, content: payloadText })
            );
            const result = await commands.execute(parsed.sessionId, '/' + SAVE_COMMAND + ' ' + payload, []);
            if (!result || result.ok !== true) {
              throw new Error(result && result.error ? reasonOf(result.error) : '保存请求被拒绝');
            }
            if (result.value === undefined) {
              throw new Error('宿主未注册 /' + SAVE_COMMAND + ' 命令（宿主半可能未启用）');
            }
            if (result.value.kind === 'error') {
              const failureText = result.value.text || '保存失败';
              if (!alive.current) return;
              if (failureText.indexOf('已被外部修改') >= 0) {
                setPhase('conflict');
                setMessage(failureText);
              } else {
                setPhase('error');
                setMessage(failureText);
              }
              return;
            }
            if (!alive.current) return;
            setOriginal(payloadText);
            setPhase('saved');
            setMessage(result.value.text || '已保存');
          } catch (error) {
            if (!alive.current) return;
            setPhase('error');
            setMessage(reasonOf(error));
          }
        }, [parsed, phase, version]);

        // 自动保存：停顿 1.5 秒写盘
        useEffect(() => {
          if (!dirty || phase === 'saving' || phase === 'loading' || phase === 'conflict') return undefined;
          if (saveTimer.current) clearTimeout(saveTimer.current);
          saveTimer.current = setTimeout(() => {
            saveTimer.current = null;
            save();
          }, AUTOSAVE_MS);
          return () => {
            if (saveTimer.current) clearTimeout(saveTimer.current);
            saveTimer.current = null;
          };
        }, [text, dirty, phase, save]);

        // Ctrl/Cmd+S 立即保存
        useEffect(() => {
          const onKeyDown = (event) => {
            if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === 's') {
              event.preventDefault();
              save();
            }
          };
          window.addEventListener('keydown', onKeyDown);
          return () => window.removeEventListener('keydown', onKeyDown);
        }, [save]);

        const busy = phase === 'loading' || phase === 'saving';
        const statusStyle = phase === 'error' || phase === 'conflict' ? S.statusError : S.status;

        const statusText = truncated
          ? '［已截断：文件过大，仅显示前 ' + MAX_PAGES * PAGE_LINES + ' 行，请勿直接保存］' + message
          : message;

        return h(
          'div',
          { style: S.root },
          h(
            'div',
            { style: S.bar },
            h('span', { style: S.path, title: parsed ? parsed.path : '' }, parsed ? parsed.path : '（未识别地址）'),
            h(
              'button',
              {
                type: 'button',
                style: dirty ? S.buttonPrimary : S.button,
                disabled: !dirty || busy || phase === 'conflict',
                onClick: save,
                title: '立即保存 (Ctrl+S)；停顿 1.5 秒会自动保存',
              },
              phase === 'saving' ? '保存中…' : dirty ? '保存 *' : '保存'
            ),
            h(
              'button',
              {
                type: 'button',
                style: S.button,
                disabled: busy,
                onClick: () => {
                  const nextRevision = contentRef.current && contentRef.current.reload;
                  if (typeof nextRevision === 'function') nextRevision();
                  else load();
                },
                title: '放弃本地修改并重新读取磁盘内容',
              },
              '重新读取'
            ),
            // 预览：跳到官方文档标签（kind 'text'）——那里有 Markdown / 代码 / 纯文本渲染器，
            // 装了 dsh-md-studio 时还能渲染 Mermaid 与 KaTeX。
            h(
              'button',
              {
                type: 'button',
                style: S.button,
                disabled: !parsed,
                onClick: () => {
                  const nav = pickService(ctx, 'sidebarRight');
                  if (!nav || typeof nav.openResource !== 'function') {
                    setPhase('error');
                    setMessage('sidebarRight 服务不可用，无法打开预览');
                    return;
                  }
                  try {
                    nav.openResource(resourceAddress, { kind: 'text' });
                  } catch (openError) {
                    setMessage('打开预览失败：' + reasonOf(openError));
                  }
                },
                title: '用官方文档标签预览（Mermaid / 公式等渲染效果）',
              },
              '预览'
            )
          ),
          h(
            'div',
            { ref: props.scrollportRef, style: S.editorHost },
            // Monaco 常驻：只在首次挂载时创建，不因 phase 在 loading/ready 之间切换而被卸载重建
            h(MonacoEditor, { value: text, onChange: setText }),
            phase === 'loading' && !text
              ? h(
                  'div',
                  {
                    style: {
                      position: 'absolute',
                      inset: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: 'var(--dsw-alias-bg-layer-1)',
                      color: 'var(--dsw-alias-label-tertiary)',
                    },
                  },
                  '正在读取…'
                )
              : null
          ),
          h('div', { style: statusStyle, title: statusText }, statusText)
        );
      };
    }

    // ============================================================ 注册
    return {
      // Cordis 服务依赖：这些是【独立的服务名】，访问其属性必须逐字声明，
      // 否则 Cordis 的服务代理会拒绝（错误原文：cannot get property "…" without inject）。
      // 依据：官方 dsh-client-ui-sidebar-documentpreview（slots / remote / remote.workspaceFiles）
      //       与 dsh-client-ui-commands、dsh-client-ui-plan（remote.commands）的 inject 数组。
      inject: ['slots', 'sidebarRight', 'remote', 'remote.workspaceFiles', 'remote.commands'],
      apply(ctx) {
        const Body = createBody(ctx);

        // `ctx.documentPreviews` 由官方插件提供，各插件激活顺序不定，
        // 因此轮询等待服务就绪，而不是一次性检查失败就放弃。
        let attempts = 0;
        const MAX_ATTEMPTS = 40; // 40 × 250ms ≈ 10 秒

        // 服务获取走多路：直接属性 → Cordis 的 ctx.get()。
        // 客户端插件对某些服务的可达性取决于它是怎么被注入的，单一路径可能永远取不到。
        function pickService(name) {
          try {
            const direct = ctx[name];
            if (direct) return direct;
          } catch {
            /* 某些 ctx 上属性访问会抛错 */
          }
          try {
            if (typeof ctx.get === 'function') return ctx.get(name);
          } catch {
            /* ignore */
          }
          return undefined;
        }

        function describe(previews, slotService) {
          const state = (value) =>
            !value ? 'missing' : typeof value.register === 'function' ? 'ok' : 'no-register';
          return 'documentPreviews=' + state(previews) + ' slots=' + state(slotService);
        }

        function beacon(stage) {
          try {
            fetch('/api/md-editor/beacon?stage=' + encodeURIComponent(stage), {
              credentials: 'same-origin',
            }).catch(function () {});
          } catch (beaconError) {
            /* 信标失败不影响插件 */
          }
        }

        function tryRegister() {
          const tabs = pickService('sidebarRightTabs');
          const slotService = pickService('slots');
          if (
            !tabs ||
            typeof tabs.register !== 'function' ||
            !slotService ||
            typeof slotService.register !== 'function'
          ) {
            attempts += 1;
            if (attempts < MAX_ATTEMPTS) {
              setTimeout(tryRegister, 250);
              return;
            }
            const detail =
              'sidebarRightTabs=' + (tabs ? 'ok' : 'missing') + ' slots=' + (slotService ? 'ok' : 'missing');
            if (typeof console !== 'undefined') {
              console.error('[dsh-md-editor] 服务未就绪，插件未注册：' + detail);
            }
            beacon('register-failed-' + detail);
            return;
          }

          // 第一层：注册自己的标签类型，正文完全自控。
          // 不再接管官方文档预览的渲染器 —— 那条路要和官方的 revision/loading 机制协作，
          // 实测会导致 effect 反复重启、Monaco 被反复重建（挂载 3 次却有 38 次 effect、11 次 monaco-ready）。
          ctx.effect(
            () =>
              tabs.register({
                id: RENDERER_ID,
                kind: 'md-editor',
                // patterns 是作用于 dsh-resource:// 地址的 glob（含点；不含 ':' 时
                // 匹配 URI 路径的任意深度且忽略大小写）
                patterns: ['*.md', '*.markdown'],
                priority: 'extension',
                title: () => 'Markdown 编辑器',
              }),
            'md-editor: tab type'
          );

          // 正文：key = 类型 id（官方文档：keyed slot sidebar.right.pane.tab）
          ctx.effect(
            () =>
              slotService.inject('sidebar.right.pane.tab', () =>
                slotService.register({ name: 'sidebar.right.pane.tab', key: RENDERER_ID }, function MdEditorSlot(props) {
                  return h(Boundary, null, h(Body, props));
                })
              ),
            'md-editor: tab body'
          );

          if (typeof console !== 'undefined') {
            console.log('[dsh-md-editor] 标签类型已注册（第一层，正文自控）');
          }
          beacon('tab-type-registered');
        }

        tryRegister();
      },
    };
  },
});
