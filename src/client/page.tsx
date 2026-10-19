/**
 * The Settings → MCP 安装 page.
 *
 * Two views:
 *  - Installed: every live `@deepseek-ai/dsh-mcp-client` row composed into the
 *    profile (profile patch / home patch / bundle layers), with transport,
 *    target, source layer, connection state and registered MCP tools. The
 *    table scrolls horizontally and vertically and every row expands into a
 *    detail panel.
 *  - Install new: the wizard state machine
 *    idle → parsing → preview → installing → done | error.
 *
 * The page owns only view state; parsing, risk assessment, Loader inspection
 * and writing all run in the Host half over the plugin's same-origin routes.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import type {
  InstallResponse,
  InstalledServer,
  McpServerSpec,
  ParseResponse,
  RiskAssessment,
  RiskLevel,
  ServersResponse,
  StatusResponse,
} from '../types.js';
import type { Translate } from './locale.js';

// Keep the public-url path prefix when DSH serves the app behind a proxy.
const API_PREFIX = './_dsh/mcp-installer';

type Tab = 'installed' | 'install';
type Phase = 'idle' | 'parsing' | 'preview' | 'installing' | 'done' | 'error';
type IconName =
  | 'refresh'
  | 'server'
  | 'plus'
  | 'edit'
  | 'trash'
  | 'save'
  | 'close'
  | 'search'
  | 'chevron'
  | 'check'
  | 'alert'
  | 'plug'
  | 'file'
  | 'link'
  | 'scroll';

interface PreviewRow {
  spec: McpServerSpec;
  risk: RiskAssessment;
  include: boolean;
  ack: boolean;
}

interface StatusState {
  value?: StatusResponse;
  error?: string;
}

interface InstalledState {
  data?: ServersResponse;
  loading: boolean;
  error?: string;
}

interface EditDraft {
  id: string;
  serverName: string;
  transport: string;
  command: string;
  args: string;
  url: string;
  acknowledged: boolean;
  acknowledgementRequired: boolean;
  saving: boolean;
  error?: string;
}

class ApiError extends Error {
  constructor(
    message: string,
    readonly payload: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface McpInstallerPageProps {
  t?: Translate;
  close?: () => void;
}

/** Throw on non-2xx / `ok: false` so the component has one error path. */
async function request<T>(route: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_PREFIX}/${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || payload.ok === false) {
    const message =
      typeof payload.error === 'string'
        ? payload.error
        : typeof payload.message === 'string'
          ? payload.message
          : `HTTP ${response.status}`;
    throw new ApiError(message, payload);
  }
  return payload as T;
}

/** Replace `{n}` / `{h}` / `{b}` placeholders in a localized string. */
function fill(t: Translate, key: string, values: Record<string, number | string>): string {
  let text = t(key);
  for (const [name, value] of Object.entries(values)) {
    text = text.replace(`{${name}}`, String(value));
  }
  return text;
}

function isRiskAssessment(value: unknown): value is RiskAssessment {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const risk = value as Record<string, unknown>;
  return (
    (risk.level === 'none' ||
      risk.level === 'warning' ||
      risk.level === 'high' ||
      risk.level === 'blocked') &&
    Array.isArray(risk.reasons) &&
    risk.reasons.every((reason) => typeof reason === 'string') &&
    typeof risk.requiresAcknowledgement === 'boolean' &&
    typeof risk.installable === 'boolean' &&
    typeof risk.networkAccess === 'boolean' &&
    Array.isArray(risk.credentialKeys) &&
    risk.credentialKeys.every((key) => typeof key === 'string')
  );
}

export function McpInstallerPage(props: McpInstallerPageProps) {
  const t: Translate = typeof props.t === 'function' ? props.t : (key) => key;

  const [tab, setTab] = useState<Tab>('installed');
  const [phase, setPhase] = useState<Phase>('idle');
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState<PreviewRow[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [source, setSource] = useState<string>('paste');
  const [error, setError] = useState('');
  const [result, setResult] = useState<InstallResponse | undefined>();
  const [status, setStatus] = useState<StatusState>({});
  const [installed, setInstalled] = useState<InstalledState>({ loading: true });
  const fileRef = useRef<HTMLInputElement | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const loadStatus = useCallback(() => {
    request<StatusResponse>('status')
      .then((value) => setStatus({ value }))
      .catch((reason: unknown) =>
        setStatus({ error: reason instanceof Error ? reason.message : String(reason) }),
      );
  }, []);

  const loadServers = useCallback(async () => {
    setInstalled((current) => ({ ...current, loading: true, error: undefined }));
    try {
      const data = await request<ServersResponse>('servers');
      setInstalled({ data, loading: false });
    } catch (reason) {
      setInstalled((current) => ({
        ...current,
        loading: false,
        error: reason instanceof Error ? reason.message : String(reason),
      }));
    }
  }, []);

  const refreshAll = useCallback(() => {
    loadStatus();
    void loadServers();
  }, [loadServers, loadStatus]);

  useEffect(() => {
    refreshAll();
    return () => {
      if (refreshTimer.current !== undefined) clearTimeout(refreshTimer.current);
    };
  }, [refreshAll]);

  const applyPreview = useCallback((payload: ParseResponse) => {
    if (!payload.risks || typeof payload.risks !== 'object' || Array.isArray(payload.risks)) {
      throw new Error(t('invalidRiskAssessment'));
    }
    const nextRows = payload.specs.map((spec) => {
      if (!Object.hasOwn(payload.risks, spec.name)) {
        throw new Error(fill(t, 'missingRiskAssessment', { name: spec.name }));
      }
      const risk: unknown = payload.risks[spec.name];
      if (!isRiskAssessment(risk)) throw new Error(t('invalidRiskAssessment'));
      return { spec, risk, include: risk.installable, ack: false };
    });
    setRows(nextRows);
    setWarnings(payload.warnings);
    setSource(payload.source);
    setError('');
    setPhase('preview');
  }, [t]);

  const fail = useCallback((reason: unknown) => {
    setError(reason instanceof Error ? reason.message : String(reason));
    setPhase('error');
  }, []);

  const parseText = useCallback(async () => {
    if (!text.trim()) {
      setError(t('emptyInput'));
      setPhase('error');
      return;
    }
    setPhase('parsing');
    try {
      applyPreview(await request<ParseResponse>('parse', { raw: text, type: 'text' }));
    } catch (reason) {
      fail(reason);
    }
  }, [applyPreview, fail, t, text]);

  const parseUrl = useCallback(async () => {
    if (!url.trim()) {
      setError(t('invalidUrl'));
      setPhase('error');
      return;
    }
    setPhase('parsing');
    try {
      applyPreview(await request<ParseResponse>('parse', { url: url.trim(), type: 'url' }));
    } catch (reason) {
      fail(reason);
    }
  }, [applyPreview, fail, t, url]);

  const pickFile = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      setFileName(file.name);
      try {
        setText(await file.text());
        setError('');
      } catch {
        setError(t('readFileFailed'));
        setPhase('error');
      }
    },
    [t],
  );

  const toggleInclude = useCallback((name: string) => {
    setRows((current) =>
      current.map((row) =>
        row.spec.name === name && row.risk.installable ? { ...row, include: !row.include } : row,
      ),
    );
  }, []);

  const toggleAck = useCallback((name: string) => {
    setRows((current) =>
      current.map((row) => (row.spec.name === name ? { ...row, ack: !row.ack } : row)),
    );
  }, []);

  const setAllIncluded = useCallback((include: boolean) => {
    setRows((current) =>
      current.map((row) => ({ ...row, include: include && row.risk.installable })),
    );
  }, []);

  const included = useMemo(
    () => rows.filter((row) => row.include && row.risk.installable),
    [rows],
  );
  const blockedIncluded = useMemo(
    () => rows.filter((row) => row.include && !row.risk.installable),
    [rows],
  );
  const pendingAck = useMemo(
    () => included.filter((row) => row.risk.requiresAcknowledgement && !row.ack),
    [included],
  );
  const highRiskCount = useMemo(
    () => rows.filter((row) => row.risk.level === 'high').length,
    [rows],
  );
  const blockedCount = useMemo(
    () => rows.filter((row) => !row.risk.installable).length,
    [rows],
  );
  const canInstall = included.length > 0 && blockedIncluded.length === 0 && pendingAck.length === 0;

  const install = useCallback(async () => {
    if (!canInstall) {
      setError(t('nothingSelected'));
      setPhase('error');
      return;
    }
    setPhase('installing');
    try {
      const payload = await request<InstallResponse>('install', {
        specs: included.map((row) => row.spec),
        acknowledged: included
          .filter((row) => row.risk.requiresAcknowledgement && row.ack)
          .map((row) => row.spec.name),
      });
      setResult(payload);
      setPhase('done');
      loadStatus();
      refreshTimer.current = setTimeout(() => void loadServers(), 1500);
    } catch (reason) {
      fail(reason);
    }
  }, [canInstall, fail, included, loadServers, loadStatus, t]);

  const resetWizard = useCallback(() => {
    setText('');
    setUrl('');
    setFileName('');
    setRows([]);
    setWarnings([]);
    setError('');
    setResult(undefined);
    setPhase('idle');
  }, []);

  const backToInstalled = useCallback(() => {
    void loadServers();
    setTab('installed');
  }, [loadServers]);

  const wizardStep: number =
    phase === 'done' ? 2 : phase === 'preview' || phase === 'installing' || phase === 'error' ? 1 : 0;

  return (
    <div className="mcpi-root">
      <style>{CSS}</style>
      <header className="mcpi-header">
        <div className="mcpi-headerText">
          <h2 className="mcpi-title">
            <Icon name="plug" className="mcpi-titleIcon" />
            {t('title')}
          </h2>
          <p className="mcpi-intro">{t('intro')}</p>
        </div>
        <button
          type="button"
          className="mcpi-iconButton"
          onClick={refreshAll}
          disabled={installed.loading}
          title={t('refresh')}
          aria-label={t('refresh')}
        >
          <Icon name="refresh" className={installed.loading ? 'mcpi-spin' : undefined} />
          <span>{installed.loading ? t('refreshing') : t('refresh')}</span>
        </button>
      </header>

      <StatusStrip t={t} status={status} />

      <div className="mcpi-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'installed'}
          className={`mcpi-tab${tab === 'installed' ? ' mcpi-tabActive' : ''}`}
          onClick={() => setTab('installed')}
        >
          <Icon name="server" />
          <span>{t('tabsInstalled')}</span>
          <span className="mcpi-tabBadge">{installed.data?.servers.length ?? '·'}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'install'}
          className={`mcpi-tab${tab === 'install' ? ' mcpi-tabActive' : ''}`}
          onClick={() => setTab('install')}
        >
          <Icon name="plus" />
          <span>{t('tabsInstall')}</span>
        </button>
      </div>

      {tab === 'installed' ? (
        <InstalledPanel
          t={t}
          state={installed}
          onRefresh={refreshAll}
          onGoInstall={() => setTab('install')}
        />
      ) : (
        <>
          <StepBar t={t} step={wizardStep} />

          {phase === 'idle' && (
            <div className="mcpi-card">
              <SectionHead
                icon="server"
                title={t('pasteTitle')}
                hint={t('pasteHint')}
                aside={<span className="mcpi-charCount">{fill(t, 'charCount', { n: text.length })}</span>}
              />
              <textarea
                className="mcpi-textarea"
                spellCheck={false}
                placeholder={t('pastePlaceholder')}
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
              <div className="mcpi-inline">
                <button type="button" className="mcpi-button" onClick={() => fileRef.current?.click()}>
                  <Icon name="file" />
                  {t('fileButton')}
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".json,.yaml,.yml,.toml,.md,.markdown,.txt"
                  className="mcpi-fileInput"
                  onChange={pickFile}
                />
                {fileName && <span className="mcpi-hint">{fileName}</span>}
                <span className="mcpi-hint">{t('fileHint')}</span>
                <span className="mcpi-spacer" />
                <button type="button" className="mcpi-button mcpi-primary" onClick={parseText}>
                  {t('parseText')}
                </button>
              </div>

              <div className="mcpi-divider" />

              <SectionHead icon="link" title={t('urlTitle')} hint={t('urlLabel')} />
              <div className="mcpi-inline">
                <input
                  className="mcpi-input"
                  type="url"
                  spellCheck={false}
                  placeholder={t('urlPlaceholder')}
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void parseUrl();
                  }}
                />
                <button type="button" className="mcpi-button" onClick={parseUrl}>
                  {t('parseUrl')}
                </button>
              </div>
            </div>
          )}

          {phase === 'parsing' && (
            <div className="mcpi-card mcpi-center">
              <span className="mcpi-spinner" aria-hidden="true" />
              <span>{t('parsing')}</span>
            </div>
          )}

          {(phase === 'preview' || phase === 'installing') && (
            <div className="mcpi-card">
              <SectionHead
                icon="alert"
                title={t('reviewTitle')}
                hint={t('reviewHint')}
                aside={
                  <div className="mcpi-statChips">
                    <span className="mcpi-stat">
                      {fill(t, 'previewSummary', {
                        n: rows.length,
                        h: highRiskCount,
                        b: blockedCount,
                      })}
                    </span>
                    <span className="mcpi-stat mcpi-statMuted">{sourceLabel(t, source)}</span>
                  </div>
                }
              />

              {warnings.length > 0 && (
                <details className="mcpi-warnBox">
                  <summary className="mcpi-warnTitle">{t('warningsMore')}</summary>
                  <ul className="mcpi-warnList">
                    {warnings.map((warning, index) => (
                      <li key={`${index}-${warning.slice(0, 24)}`}>{warning}</li>
                    ))}
                  </ul>
                </details>
              )}

              {rows.length === 0 ? (
                <div className="mcpi-empty">
                  <Icon name="alert" className="mcpi-emptyIcon" />
                  <div className="mcpi-emptyTitle">{t('noSpecs')}</div>
                  <p className="mcpi-hint">{t('noSpecsHint')}</p>
                </div>
              ) : (
                <>
                  <div className="mcpi-toolbar">
                    <div className="mcpi-inline">
                      <button
                        type="button"
                        className="mcpi-button mcpi-small"
                        onClick={() => setAllIncluded(true)}
                      >
                        {t('selectAll')}
                      </button>
                      <button
                        type="button"
                        className="mcpi-button mcpi-small"
                        onClick={() => setAllIncluded(false)}
                      >
                        {t('clearAll')}
                      </button>
                    </div>
                    {blockedIncluded.length > 0 && <p className="mcpi-errorText">{t('blockedHint')}</p>}
                    {pendingAck.length > 0 && <p className="mcpi-warnText">{t('highRiskHint')}</p>}
                  </div>
                  <div className="mcpi-tableWrap">
                    <table className="mcpi-table mcpi-previewTable">
                      <thead>
                        <tr>
                          <th className="mcpi-colInclude">{t('colInclude')}</th>
                          <th>{t('colName')}</th>
                          <th>{t('colTransport')}</th>
                          <th>{t('colTarget')}</th>
                          <th>{t('colRisk')}</th>
                          <th className="mcpi-colChevron" />
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row) => (
                          <PreviewTableRow
                            key={row.spec.name}
                            t={t}
                            row={row}
                            disabled={phase === 'installing'}
                            onToggleInclude={() => toggleInclude(row.spec.name)}
                            onToggleAck={() => toggleAck(row.spec.name)}
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              <div className="mcpi-actions">
                <button
                  type="button"
                  className="mcpi-button"
                  onClick={resetWizard}
                  disabled={phase === 'installing'}
                >
                  {t('backToEdit')}
                </button>
                <button
                  type="button"
                  className="mcpi-button mcpi-primary"
                  onClick={install}
                  disabled={!canInstall || phase === 'installing'}
                >
                  {phase === 'installing' ? (
                    <>
                      <span className="mcpi-spinner mcpi-spinnerSmall" aria-hidden="true" />
                      {t('installing')}
                    </>
                  ) : (
                    t('installButton')
                  )}
                </button>
              </div>
            </div>
          )}

          {phase === 'done' && result && (
            <div className="mcpi-card mcpi-done">
              <div className="mcpi-successHead">
                <span className="mcpi-successIcon">
                  <Icon name="check" />
                </span>
                <div>
                  <h3 className="mcpi-cardTitle">{t('doneTitle')}</h3>
                  <p className="mcpi-hint">{t('reinstallHint')}</p>
                </div>
              </div>
              {result.file && (
                <div className="mcpi-kv">
                  <span className="mcpi-kvLabel">{t('target')}</span>
                  <code className="mcpi-code">{result.file}</code>
                </div>
              )}
              {result.entries && result.entries.length > 0 && (
                <div className="mcpi-kv">
                  <span className="mcpi-kvLabel">{t('colName')}</span>
                  <div className="mcpi-chipRow">
                    {result.entries.map((entry) => (
                      <span key={entry} className="mcpi-chip mcpi-chip-none">
                        {entry}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              <p className="mcpi-doneMessage">{result.message}</p>
              <p className="mcpi-hint">{t('doneTabHint')}</p>
              <div className="mcpi-actions">
                <button type="button" className="mcpi-button" onClick={resetWizard}>
                  {t('installAnother')}
                </button>
                <button type="button" className="mcpi-button mcpi-primary" onClick={backToInstalled}>
                  <Icon name="server" />
                  {t('viewInstalled')}
                </button>
              </div>
            </div>
          )}

          {phase === 'error' && (
            <div className="mcpi-card mcpi-error">
              <SectionHead icon="alert" title={t('errorTitle')} kind="error" />
              <p className="mcpi-errorText mcpi-preWrap">{error}</p>
              <div className="mcpi-actions">
                <button
                  type="button"
                  className="mcpi-button"
                  onClick={() => {
                    setError('');
                    setPhase(rows.length > 0 ? 'preview' : 'idle');
                  }}
                >
                  {t('retry')}
                </button>
                <button type="button" className="mcpi-button" onClick={resetWizard}>
                  {t('dismiss')}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── installed servers view ─────────────────────────────────────────────────

function InstalledPanel({
  t,
  state,
  onRefresh,
  onGoInstall,
}: {
  t: Translate;
  state: InstalledState;
  onRefresh: () => void;
  onGoInstall: () => void;
}) {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditDraft | undefined>();
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState('');

  const startEdit = (server: InstalledServer) => {
    setDeleteError('');
    setEditing({
      id: server.id,
      serverName: server.serverName,
      transport: server.transport,
      command: server.command ?? '',
      args: (server.args ?? []).join('\n'),
      url: server.url ?? '',
      acknowledged: false,
      acknowledgementRequired: false,
      saving: false,
    });
  };

  const saveEdit = async () => {
    if (!editing) return;
    const spec: McpServerSpec =
      editing.transport === 'stdio'
        ? {
            name: editing.serverName,
            transport: 'stdio',
            command: editing.command.trim(),
            args: editing.args === '' ? [] : editing.args.split(/\r?\n/u),
            source: 'paste',
          }
        : {
            name: editing.serverName,
            transport: 'streamable-http',
            url: editing.url.trim(),
            source: 'paste',
          };
    setEditing({ ...editing, saving: true, error: undefined });
    try {
      await request<InstallResponse>('update', {
        id: editing.id,
        serverName: editing.serverName,
        spec,
        acknowledged: editing.acknowledged ? [editing.serverName] : [],
      });
      setEditing(undefined);
      onRefresh();
    } catch (reason) {
      if (reason instanceof ApiError && reason.payload.acknowledgementRequired === true) {
        setEditing({
          ...editing,
          acknowledgementRequired: true,
          error: t('editAckRequired'),
          saving: false,
        });
      } else {
        setEditing({
          ...editing,
          error: reason instanceof Error ? reason.message : String(reason),
          saving: false,
        });
      }
    }
  };

  const deleteServer = async (server: InstalledServer) => {
    if (!window.confirm(fill(t, 'confirmDelete', { name: server.serverName }))) return;
    setDeleting(server.id);
    setDeleteError('');
    try {
      await request<InstallResponse>('delete', { id: server.id, serverName: server.serverName });
      setExpanded(null);
      setEditing(undefined);
      onRefresh();
    } catch (reason) {
      setDeleteError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setDeleting(null);
    }
  };

  const servers = state.data?.servers ?? [];
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return servers;
    return servers.filter((server) =>
      [server.serverName, server.id, server.command ?? '', server.url ?? '', server.transport]
        .join(' ')
        .toLowerCase()
        .includes(needle),
    );
  }, [query, servers]);

  const activeCount = servers.filter((server) => server.active).length;
  const toolTotal = servers.reduce((sum, server) => sum + server.toolCount, 0);

  return (
    <section className="mcpi-card">
      <SectionHead
        icon="server"
        title={t('installedTitle')}
        hint={t('installedSubtitle')}
        aside={
          <button
            type="button"
            className="mcpi-iconButton"
            onClick={onRefresh}
            disabled={state.loading}
            title={t('refresh')}
            aria-label={t('refresh')}
          >
            <Icon name="refresh" className={state.loading ? 'mcpi-spin' : undefined} />
            <span>{state.loading ? t('refreshing') : t('refresh')}</span>
          </button>
        }
      />

      <div className="mcpi-toolbar">
        <label className="mcpi-search">
          <Icon name="search" />
          <input
            type="search"
            value={query}
            spellCheck={false}
            placeholder={t('searchPlaceholder')}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="mcpi-statChips">
          <span className="mcpi-stat">{fill(t, 'summaryServers', { n: servers.length })}</span>
          <span className={`mcpi-stat ${activeCount > 0 ? 'mcpi-statOk' : ''}`}>
            {fill(t, 'summaryActive', { n: activeCount })}
          </span>
          <span className="mcpi-stat">{fill(t, 'summaryTools', { n: toolTotal })}</span>
        </div>
      </div>

      {state.data && !state.data.toolsAvailable && (
        <p className="mcpi-hint">{t('toolsUnavailable')}</p>
      )}
      {state.error && (
        <p className="mcpi-errorText">
          {t('installedError')}：{state.error}
        </p>
      )}
      {state.data && state.data.warnings.length > 0 && (
        <details className="mcpi-warnBox">
          <summary className="mcpi-warnTitle">{t('warningsMore')}</summary>
          <ul className="mcpi-warnList">
            {state.data.warnings.map((warning, index) => (
              <li key={`${index}-${warning.slice(0, 24)}`}>{warning}</li>
            ))}
          </ul>
        </details>
      )}

      {state.loading && !state.data && (
        <div className="mcpi-center">
          <span className="mcpi-spinner" aria-hidden="true" />
          <span>{t('installedLoading')}</span>
        </div>
      )}

      {state.data && servers.length === 0 && !state.error && (
        <div className="mcpi-empty">
          <Icon name="server" className="mcpi-emptyIcon" />
          <div className="mcpi-emptyTitle">{t('emptyInstalled')}</div>
          <p className="mcpi-hint">{t('emptyInstalledHint')}</p>
          <button type="button" className="mcpi-button mcpi-primary" onClick={onGoInstall}>
            <Icon name="plus" />
            {t('goInstall')}
          </button>
        </div>
      )}

      {servers.length > 0 && filtered.length === 0 && (
        <p className="mcpi-hint">{t('filterEmpty')}</p>
      )}

      {filtered.length > 0 && (
        <div className="mcpi-tableWrap mcpi-tableWrapTall">
          <table className="mcpi-table mcpi-installedTable">
            <thead>
              <tr>
                <th className="mcpi-colNameSticky">{t('colName')}</th>
                <th>{t('colTransport')}</th>
                <th>{t('colTarget')}</th>
                <th>{t('colLayer')}</th>
                <th className="mcpi-colNum">{t('colTools')}</th>
                <th>{t('colStatus')}</th>
                <th className="mcpi-colChevron" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((server) => {
                const isOpen = expanded === server.id;
                return (
                  <Fragment key={server.id}>
                    <tr
                      className={`mcpi-clickRow${isOpen ? ' mcpi-rowOpen' : ''}${
                        server.active ? '' : ' mcpi-rowDim'
                      }`}
                      tabIndex={0}
                      aria-expanded={isOpen}
                      onClick={() => setExpanded(isOpen ? null : server.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setExpanded(isOpen ? null : server.id);
                        }
                      }}
                    >
                      <td className="mcpi-colNameSticky">
                        <div className="mcpi-name">{server.serverName}</div>
                        <div className="mcpi-meta">{server.id}</div>
                      </td>
                      <td>
                        <TransportBadge transport={server.transport} />
                      </td>
                      <td>
                        <code className="mcpi-code mcpi-target" title={installedTarget(server)}>
                          {installedTarget(server)}
                        </code>
                      </td>
                      <td>
                        <LayerBadge t={t} layer={server.layer} />
                      </td>
                      <td className="mcpi-colNum">
                        {state.data?.toolsAvailable ? (
                          <span
                            className={`mcpi-toolCount${
                              server.toolCount > 0 ? ' mcpi-toolCountOn' : ''
                            }`}
                          >
                            {server.toolCount}
                          </span>
                        ) : (
                          <span className="mcpi-muted">–</span>
                        )}
                      </td>
                      <td>
                        <StatusPill t={t} active={server.active} />
                      </td>
                      <td className="mcpi-colChevron">
                        <Icon
                          name="chevron"
                          className={`mcpi-chevron${isOpen ? ' mcpi-chevronOpen' : ''}`}
                        />
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="mcpi-detailRow">
                        <td colSpan={7}>
                          <div className="mcpi-detailGrid">
                            <DetailItem label={t('serverId')}>
                              <code className="mcpi-code">{server.id}</code>
                            </DetailItem>
                            <DetailItem label={t('colTransport')}>
                              <TransportBadge transport={server.transport} />
                            </DetailItem>
                            <DetailItem label={t('colLayer')}>
                              <LayerBadge t={t} layer={server.layer} />
                            </DetailItem>
                            <DetailItem label={t('commandLabel')}>
                              <code className="mcpi-code">{server.command ?? t('none')}</code>
                            </DetailItem>
                            <DetailItem label={t('urlField')}>
                              <code className="mcpi-code mcpi-breakable">
                                {server.url ?? t('none')}
                              </code>
                            </DetailItem>
                            <DetailItem label={t('argsLabel')}>
                              <ChipRow values={server.args ?? []} empty={t('noArgs')} mono />
                            </DetailItem>
                            <DetailItem label={t('envKeysLabel')}>
                              <ChipRow values={server.envKeys} empty={t('noEnv')} />
                            </DetailItem>
                            <DetailItem label={t('headerKeysLabel')}>
                              <ChipRow values={server.headerKeys} empty={t('noHeaders')} />
                            </DetailItem>
                            <DetailItem label={t('toolsLabel')}>
                              <ChipRow
                                values={(server.tools ?? []).map((name) =>
                                  name.startsWith(`mcp__${server.serverName}__`)
                                    ? name.slice(`mcp__${server.serverName}__`.length)
                                    : name,
                                )}
                                empty={t('noTools')}
                                tone="tool"
                              />
                            </DetailItem>
                          </div>
                          <p
                            className={`mcpi-hint ${
                              server.active ? 'mcpi-hintOk' : 'mcpi-hintWarn'
                            }`}
                          >
                            {server.active ? t('activeHint') : t('inactiveHint')}
                          </p>
                          {server.editable && server.layer === 'profile' &&
                            (server.transport === 'stdio' || server.transport === 'streamable-http') && (
                              editing?.id === server.id ? (
                                <div className="mcpi-editForm">
                                  <div className="mcpi-editHeading">
                                    <strong>{t('editTitle')}: {server.serverName}</strong>
                                    <span className="mcpi-muted">{server.transport}</span>
                                  </div>
                                  {server.transport === 'stdio' ? (
                                    <>
                                      <label className="mcpi-field">
                                        <span>{t('commandLabel')}</span>
                                        <input
                                          value={editing.command}
                                          onChange={(event) => setEditing({ ...editing, command: event.target.value })}
                                          disabled={editing.saving}
                                        />
                                      </label>
                                      <label className="mcpi-field">
                                        <span>{t('argsLabel')}</span>
                                        <textarea
                                          value={editing.args}
                                          onChange={(event) => setEditing({ ...editing, args: event.target.value })}
                                          disabled={editing.saving}
                                          rows={3}
                                        />
                                      </label>
                                    </>
                                  ) : (
                                    <label className="mcpi-field">
                                      <span>{t('urlField')}</span>
                                      <input
                                        value={editing.url}
                                        onChange={(event) => setEditing({ ...editing, url: event.target.value })}
                                        disabled={editing.saving}
                                      />
                                    </label>
                                  )}
                                  <p className="mcpi-hint">{t('secretsPreserved')}</p>
                                  {editing.acknowledgementRequired && (
                                    <label className="mcpi-ack">
                                      <input
                                        type="checkbox"
                                        checked={editing.acknowledged}
                                        onChange={(event) =>
                                          setEditing({ ...editing, acknowledged: event.target.checked })
                                        }
                                      />
                                      {t('ack')}
                                    </label>
                                  )}
                                  {editing.error && <p className="mcpi-errorText">{editing.error}</p>}
                                  <div className="mcpi-editActions">
                                    <button
                                      type="button"
                                      className="mcpi-button mcpi-primary"
                                      onClick={() => void saveEdit()}
                                      disabled={editing.saving || (editing.acknowledgementRequired && !editing.acknowledged)}
                                    >
                                      <Icon name="save" />
                                      {editing.saving ? t('saving') : t('save')}
                                    </button>
                                    <button
                                      type="button"
                                      className="mcpi-button"
                                      onClick={() => setEditing(undefined)}
                                      disabled={editing.saving}
                                      title={t('cancel')}
                                      aria-label={t('cancel')}
                                    >
                                      <Icon name="close" />
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <div className="mcpi-editActions">
                                  <button
                                    type="button"
                                    className="mcpi-button"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      startEdit(server);
                                    }}
                                  >
                                    <Icon name="edit" />
                                    {t('edit')}
                                  </button>
                                  <button
                                    type="button"
                                    className="mcpi-button mcpi-dangerButton"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      void deleteServer(server);
                                    }}
                                    disabled={deleting === server.id}
                                  >
                                    <Icon name="trash" />
                                    {deleting === server.id ? t('deleting') : t('delete')}
                                  </button>
                                </div>
                              )
                            )}
                          {!server.editable && <p className="mcpi-hint">{t('readOnlyLayer')}</p>}
                          {deleteError && <p className="mcpi-errorText">{deleteError}</p>}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {servers.length > 0 && (
        <p className="mcpi-scrollHint">
          <Icon name="scroll" />
          {t('scrollHint')}
        </p>
      )}
    </section>
  );
}

// ── preview table row ──────────────────────────────────────────────────────

function PreviewTableRow({
  t,
  row,
  disabled,
  onToggleInclude,
  onToggleAck,
}: {
  t: Translate;
  row: PreviewRow;
  disabled: boolean;
  onToggleInclude: () => void;
  onToggleAck: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr
        className={`mcpi-clickRow${row.include ? ' mcpi-rowOn' : ''}${open ? ' mcpi-rowOpen' : ''}${
          row.risk.installable ? '' : ' mcpi-rowBlocked'
        }`}
      >
        <td className="mcpi-colInclude">
          <input
            type="checkbox"
            aria-label={row.spec.name}
            checked={row.include}
            disabled={!row.risk.installable || disabled}
            onChange={onToggleInclude}
          />
        </td>
        <td>
          <div className="mcpi-name">{row.spec.name}</div>
          <div className="mcpi-meta">{sourceLabel(t, row.spec.source)}</div>
        </td>
        <td>
          <TransportBadge transport={row.spec.transport} />
        </td>
        <td>
          <code className="mcpi-code mcpi-target" title={formatTarget(row.spec)}>
            {formatTarget(row.spec)}
          </code>
        </td>
        <td>
          <RiskChip t={t} level={row.risk.level} />
          <div className="mcpi-meta">
            {row.risk.networkAccess ? `${t('network')} · ` : ''}
            {row.risk.credentialKeys.length > 0
              ? `${t('credentials')}: ${row.risk.credentialKeys.join(', ')}`
              : ''}
          </div>
          {!row.risk.installable && <div className="mcpi-errorText">{t('unsupported')}</div>}
          {row.risk.requiresAcknowledgement && row.risk.installable && (
            <label className="mcpi-ack">
              <input type="checkbox" checked={row.ack} disabled={disabled} onChange={onToggleAck} />
              <span>{t('ack')}</span>
            </label>
          )}
        </td>
        <td className="mcpi-colChevron">
          <button
            type="button"
            className="mcpi-chevronButton"
            aria-label={open ? t('collapseRow') : t('expandRow')}
            title={open ? t('collapseRow') : t('expandRow')}
            onClick={() => setOpen((value) => !value)}
          >
            <Icon name="chevron" className={`mcpi-chevron${open ? ' mcpi-chevronOpen' : ''}`} />
          </button>
        </td>
      </tr>
      {open && (
        <tr className="mcpi-detailRow">
          <td colSpan={6}>
            <div className="mcpi-detailGrid">
              <DetailItem label={t('commandLabel')}>
                <code className="mcpi-code">{row.spec.command ?? t('none')}</code>
              </DetailItem>
              <DetailItem label={t('urlField')}>
                <code className="mcpi-code mcpi-breakable">{row.spec.url ?? t('none')}</code>
              </DetailItem>
              <DetailItem label={t('argsLabel')}>
                <ChipRow values={row.spec.args ?? []} empty={t('noArgs')} mono />
              </DetailItem>
              <DetailItem label={t('envKeysLabel')}>
                <ChipRow values={Object.keys(row.spec.env ?? {})} empty={t('noEnv')} />
              </DetailItem>
              <DetailItem label={t('headerKeysLabel')}>
                <ChipRow values={Object.keys(row.spec.headers ?? {})} empty={t('noHeaders')} />
              </DetailItem>
            </div>
            {row.risk.reasons.length > 0 && (
              <ul className="mcpi-reasons">
                {row.risk.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

// ── small presentational pieces ────────────────────────────────────────────

function StatusStrip({ t, status }: { t: Translate; status: StatusState }) {
  if (status.error) {
    return (
      <div className="mcpi-status">
        <span className="mcpi-errorText">
          {t('statusError')}：{status.error}
        </span>
      </div>
    );
  }
  if (!status.value) {
    return <div className="mcpi-status">{t('loadingStatus')}</div>;
  }
  const { file, profile, existing, writable } = status.value;
  return (
    <div className="mcpi-status">
      <div className="mcpi-statusRow">
        <span className="mcpi-statusLabel">{t('target')}</span>
        <code className="mcpi-code mcpi-breakable">{file}</code>
        <span className={writable ? 'mcpi-okText' : 'mcpi-errorText'}>
          {writable ? t('writable') : t('readonly')}
        </span>
      </div>
      <div className="mcpi-statusRow">
        {profile && (
          <>
            <span className="mcpi-statusLabel">{t('profile')}</span>
            <span>{profile}</span>
          </>
        )}
        <span className="mcpi-statusLabel">{t('existing')}</span>
        <span>
          {existing.length > 0
            ? existing.map((server) => `${server.serverName}（${server.id}）`).join('、')
            : t('none')}
        </span>
      </div>
    </div>
  );
}

function StepBar({ t, step }: { t: Translate; step: number }) {
  const steps = [t('step1'), t('step2'), t('step3')];
  return (
    <div className="mcpi-steps" aria-label="progress">
      {steps.map((label, index) => (
        <Fragment key={label}>
          <div
            className={`mcpi-step${index === step ? ' mcpi-stepActive' : ''}${
              index < step ? ' mcpi-stepDone' : ''
            }`}
          >
            <span className="mcpi-stepDot">{index < step ? <Icon name="check" /> : index + 1}</span>
            <span className="mcpi-stepLabel">{label}</span>
          </div>
          {index < steps.length - 1 && (
            <span className={`mcpi-stepLine${index < step ? ' mcpi-stepLineDone' : ''}`} />
          )}
        </Fragment>
      ))}
    </div>
  );
}

function SectionHead({
  icon,
  title,
  hint,
  aside,
  kind,
}: {
  icon: IconName;
  title: string;
  hint?: string;
  aside?: ReactNode;
  kind?: 'error';
}) {
  return (
    <div className="mcpi-sectionHead">
      <div className="mcpi-sectionTitleRow">
        <span className={`mcpi-sectionIcon${kind === 'error' ? ' mcpi-sectionIconError' : ''}`}>
          <Icon name={icon} />
        </span>
        <h3 className={`mcpi-cardTitle${kind === 'error' ? ' mcpi-errorText' : ''}`}>{title}</h3>
        {aside && <div className="mcpi-sectionAside">{aside}</div>}
      </div>
      {hint && <p className="mcpi-hint">{hint}</p>}
    </div>
  );
}

function DetailItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mcpi-detail">
      <div className="mcpi-detailLabel">{label}</div>
      <div className="mcpi-detailValue">{children}</div>
    </div>
  );
}

function ChipRow({
  values,
  empty,
  mono,
  tone,
}: {
  values: string[];
  empty: string;
  mono?: boolean;
  tone?: 'tool';
}) {
  if (values.length === 0) return <span className="mcpi-muted">{empty}</span>;
  return (
    <div className="mcpi-chipRow">
      {values.map((value) => (
        <code
          key={value}
          className={`mcpi-chip mcpi-chipSoft${mono ? ' mcpi-chipMono' : ''}${
            tone === 'tool' ? ' mcpi-chipTool' : ''
          }`}
          title={value}
        >
          {value}
        </code>
      ))}
    </div>
  );
}

function TransportBadge({ transport }: { transport: string }) {
  const known = transport === 'stdio' || transport === 'streamable-http';
  return (
    <span className={`mcpi-transport${known ? '' : ' mcpi-transportUnknown'}`} title={transport}>
      {transport === 'streamable-http' ? 'http' : transport}
    </span>
  );
}

function LayerBadge({ t, layer }: { t: Translate; layer: InstalledServer['layer'] }) {
  const text =
    layer === 'profile'
      ? t('layerProfile')
      : layer === 'home'
        ? t('layerHome')
        : layer === 'bundle'
          ? t('layerBundle')
          : t('layerUnknown');
  return <span className={`mcpi-layer mcpi-layer-${layer}`}>{text}</span>;
}

function StatusPill({ t, active }: { t: Translate; active: boolean }) {
  return (
    <span className={`mcpi-statusPill${active ? ' mcpi-statusPillOn' : ''}`}>
      <span className="mcpi-dot" />
      {active ? t('connected') : t('inactive')}
    </span>
  );
}

function RiskChip({ t, level }: { t: Translate; level: RiskLevel }) {
  const label =
    level === 'blocked'
      ? t('riskBlocked')
      : level === 'high'
        ? t('riskHigh')
        : level === 'warning'
          ? t('riskWarning')
          : t('riskNone');
  return (
    <span className={`mcpi-chip mcpi-chip-${level}`}>
      <span className="mcpi-dot" />
      {label}
    </span>
  );
}

function Icon({ name, className }: { name: IconName; className?: string }) {
  const content: Record<IconName, ReactNode> = {
    refresh: <path d="M13 8a5 5 0 1 1-1.46-3.54M13 3v3h-3" />,
    server: (
      <>
        <rect x="2.5" y="2.5" width="11" height="4.4" rx="1" />
        <rect x="2.5" y="9.1" width="11" height="4.4" rx="1" />
        <circle cx="4.9" cy="4.7" r="0.6" fill="currentColor" stroke="none" />
        <circle cx="4.9" cy="11.3" r="0.6" fill="currentColor" stroke="none" />
      </>
    ),
    plus: <path d="M8 3v10M3 8h10" />,
    edit: <path d="m3 11.8.8-3.1L10.9 1.6a1.4 1.4 0 0 1 2 2L5.8 10.7zM8.5 4l2.5 2.5M3 14h10" />,
    trash: <><path d="M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.6 9h4.8l.6-9M6.5 6.5v5M9.5 6.5v5" /></>,
    save: <><path d="M3 2.5h8l2 2v9H3zM5 2.5v4h5v-4M5.5 13.5v-4h5v4" /></>,
    close: <path d="m4 4 8 8M12 4l-8 8" />,
    search: (
      <>
        <circle cx="7" cy="7" r="4" />
        <path d="m10 10 3 3" />
      </>
    ),
    chevron: <path d="m6 4 4 4-4 4" />,
    check: <path d="m3.5 8.5 3 3 6-7" />,
    alert: (
      <>
        <path d="M8 2.6 14 13H2z" />
        <path d="M8 6.6v3" />
        <circle cx="8" cy="11.4" r="0.5" fill="currentColor" stroke="none" />
      </>
    ),
    plug: <path d="M6 2v3M10 2v3M4.5 5h7v2a3.5 3.5 0 0 1-7 0zM8 10.5V14" />,
    file: <path d="M4 2h5l3 3v9H4zM9 2v3h3" />,
    link: (
      <path d="M6.5 9.5 9.5 6.5M7 4.5 8.2 3.3a2.5 2.5 0 0 1 3.5 3.5L10.5 8M5.5 8 4.3 9.2a2.5 2.5 0 0 0 3.5 3.5L9 11.5" />
    ),
    scroll: <path d="M8 2v12M5 5l3-3 3 3M5 11l3 3 3-3" />,
  };
  return (
    <svg
      className={`mcpi-icon${className ? ` ${className}` : ''}`}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {content[name]}
    </svg>
  );
}

// ── text helpers ───────────────────────────────────────────────────────────

function sourceLabel(t: Translate, source: string): string {
  if (source === 'markdown') return t('sourceMarkdown');
  if (source === 'web') return t('sourceWeb');
  return t('sourcePaste');
}

function formatTarget(spec: McpServerSpec): string {
  const raw =
    spec.transport === 'stdio'
      ? [spec.command ?? '', ...(spec.args ?? [])].join(' ').trim()
      : (spec.url ?? '');
  if (raw.length <= 160) return raw;
  return `${raw.slice(0, 157)}…`;
}

function installedTarget(server: InstalledServer): string {
  const raw =
    server.transport === 'stdio'
      ? [server.command ?? '', ...(server.args ?? [])].join(' ').trim()
      : (server.url ?? '');
  if (raw.length <= 160) return raw;
  return `${raw.slice(0, 157)}…`;
}

// ── styles (component-local; unmounted with the page) ──────────────────────
// Only DSH theme tokens are used, so light/dark themes follow automatically.

const CSS = `
.mcpi-root{max-width:1040px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:14px;padding-bottom:36px;line-height:1.5}
.mcpi-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
.mcpi-headerText{min-width:0;display:flex;flex-direction:column;gap:6px}
.mcpi-title{margin:0;font-size:19px;font-weight:600;display:flex;align-items:center;gap:8px}
.mcpi-titleIcon{width:20px;height:20px;color:var(--dsw-alias-brand-primary)}
.mcpi-intro{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;max-width:760px}
.mcpi-icon{width:15px;height:15px;flex:none}
.mcpi-spin{animation:mcpi-spin .9s linear infinite}
.mcpi-iconButton{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:12.5px;cursor:pointer;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);padding:6px 10px;flex:none}
.mcpi-iconButton:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-secondary)}
.mcpi-iconButton:disabled{opacity:.6;cursor:default}
.mcpi-card{border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:16px;display:flex;flex-direction:column;gap:12px;box-shadow:0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent)}
.mcpi-cardTitle{margin:0;font-size:14px;font-weight:600}
.mcpi-sectionHead{display:flex;flex-direction:column;gap:6px}
.mcpi-sectionTitleRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mcpi-sectionIcon{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:7px;background:color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);color:var(--dsw-alias-brand-primary);flex:none}
.mcpi-sectionIconError{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);color:var(--dsw-alias-state-error-primary)}
.mcpi-sectionAside{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mcpi-status{border:.5px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:10px 14px;display:flex;flex-direction:column;gap:6px;font-size:12.5px}
.mcpi-statusRow{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.mcpi-statusLabel{color:var(--dsw-alias-label-tertiary);flex:none}
.mcpi-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;background:var(--dsw-alias-bg-layer-2);border-radius:5px;padding:2px 6px;word-break:break-all;color:var(--dsw-alias-label-secondary)}
.mcpi-breakable{overflow-wrap:anywhere}
.mcpi-tabs{display:inline-flex;align-items:center;gap:4px;padding:4px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l1);align-self:flex-start}
.mcpi-tab{display:inline-flex;align-items:center;gap:7px;font:inherit;font-size:13px;cursor:pointer;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);padding:6px 12px}
.mcpi-tab:hover{color:var(--dsw-alias-label-primary)}
.mcpi-tabActive{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent)}
.mcpi-tabBadge{font-size:11px;min-width:18px;text-align:center;border-radius:999px;padding:0 6px;background:color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent);color:var(--dsw-alias-brand-primary)}
.mcpi-label{font-size:13px;color:var(--dsw-alias-label-secondary)}
.mcpi-textarea{width:100%;min-height:220px;box-sizing:border-box;resize:vertical;border:.5px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.55;padding:11px 12px}
.mcpi-input{flex:1;min-width:260px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px;padding:8px 11px}
.mcpi-textarea:focus,.mcpi-input:focus,.mcpi-search:focus-within{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.mcpi-hint{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.mcpi-hintOk{color:var(--dsw-alias-state-success-primary)}
.mcpi-hintWarn{color:var(--dsw-alias-state-warn-primary)}
.mcpi-inline{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.mcpi-spacer{flex:1}
.mcpi-divider{height:.5px;background:var(--dsw-alias-border-l1);margin:2px 0}
.mcpi-fileInput{display:none}
.mcpi-charCount{font-size:11.5px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.mcpi-actions{display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap}
.mcpi-button{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:13px;cursor:pointer;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);padding:7px 13px;transition:background .12s ease,border-color .12s ease}
.mcpi-button:hover:not(:disabled){border-color:var(--dsw-alias-label-secondary)}
.mcpi-button:disabled{opacity:.5;cursor:not-allowed}
.mcpi-dangerButton{color:var(--dsw-alias-state-error-primary)}
.mcpi-editActions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px}
.mcpi-editForm{display:flex;flex-direction:column;gap:9px;margin-top:14px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l1)}
.mcpi-editHeading{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12.5px}
.mcpi-field{display:flex;flex-direction:column;gap:4px;font-size:11.5px;color:var(--dsw-alias-label-tertiary);max-width:680px}
.mcpi-field input,.mcpi-field textarea{font:inherit;font-size:12.5px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;padding:7px 9px;min-width:0;resize:vertical}
.mcpi-field input:focus,.mcpi-field textarea:focus{outline:1px solid var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.mcpi-field input:disabled,.mcpi-field textarea:disabled{opacity:.6}
.mcpi-small{padding:4px 10px;font-size:12px}
.mcpi-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
.mcpi-primary:hover:not(:disabled){filter:brightness(1.06);border-color:var(--dsw-alias-brand-primary)}
.mcpi-center{display:flex;align-items:center;justify-content:center;gap:10px;min-height:110px;color:var(--dsw-alias-label-secondary);font-size:13px;flex-direction:row}
.mcpi-spinner{width:15px;height:15px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);animation:mcpi-spin .8s linear infinite;flex:none}
.mcpi-spinnerSmall{width:12px;height:12px;border-width:1.5px}
@keyframes mcpi-spin{to{transform:rotate(360deg)}}
.mcpi-warnBox{border-left:3px solid var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-bg-layer-2);border-radius:7px;padding:9px 11px;font-size:12px}
.mcpi-warnTitle{font-weight:600;cursor:pointer;color:var(--dsw-alias-label-secondary)}
.mcpi-warnList,.mcpi-reasons{margin:6px 0 0;padding-left:16px;display:flex;flex-direction:column;gap:3px}
.mcpi-warnList{color:var(--dsw-alias-label-secondary)}
.mcpi-reasons{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:8px}
.mcpi-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.mcpi-search{display:flex;align-items:center;gap:7px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:6px 10px;min-width:250px;flex:1;max-width:340px;color:var(--dsw-alias-label-tertiary)}
.mcpi-search input{flex:1;border:0;background:transparent;color:var(--dsw-alias-label-primary);font-size:12.5px;outline:none;min-width:0}
.mcpi-statChips{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.mcpi-stat{font-size:11.5px;border-radius:999px;padding:2px 9px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border:.5px solid var(--dsw-alias-border-l1);font-variant-numeric:tabular-nums}
.mcpi-statOk{color:var(--dsw-alias-state-success-primary)}
.mcpi-statMuted{color:var(--dsw-alias-label-tertiary)}
.mcpi-tableWrap{border:.5px solid var(--dsw-alias-border-l1);border-radius:9px;overflow:auto;max-height:430px;background:var(--dsw-alias-bg-layer-1)}
.mcpi-tableWrapTall{max-height:500px}
.mcpi-table{width:100%;border-collapse:separate;border-spacing:0;font-size:12.5px;min-width:880px}
.mcpi-table th{position:sticky;top:0;z-index:2;text-align:left;font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-tertiary);padding:9px 10px;background:var(--dsw-alias-bg-layer-2);border-bottom:.5px solid var(--dsw-alias-border-l2);white-space:nowrap}
.mcpi-table td{padding:10px;border-bottom:.5px solid var(--dsw-alias-border-l1);vertical-align:top}
.mcpi-table tbody tr:last-child td{border-bottom:0}
.mcpi-clickRow{cursor:pointer;transition:background .12s ease}
.mcpi-clickRow:hover td{background:color-mix(in srgb, var(--dsw-alias-bg-layer-2) 70%, transparent)}
.mcpi-rowOpen td{background:color-mix(in srgb, var(--dsw-alias-brand-primary) 6%, var(--dsw-alias-bg-layer-1))}
.mcpi-rowDim td{opacity:.72}
.mcpi-rowBlocked td{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 5%, transparent)}
.mcpi-rowOn td{background:color-mix(in srgb, var(--dsw-alias-bg-layer-2) 45%, transparent)}
.mcpi-colNameSticky{position:sticky;left:0;z-index:1;background:var(--dsw-alias-bg-layer-1);min-width:170px}
.mcpi-table th.mcpi-colNameSticky{z-index:3;background:var(--dsw-alias-bg-layer-2)}
.mcpi-colInclude{width:52px;text-align:center}
.mcpi-colNum{width:64px;text-align:center}
.mcpi-colChevron{width:36px;text-align:center}
.mcpi-name{font-weight:600;word-break:break-all}
.mcpi-meta{font-size:11.5px;color:var(--dsw-alias-label-tertiary);margin-top:2px;min-height:1px}
.mcpi-target{display:inline-block;max-width:330px;overflow-wrap:anywhere}
.mcpi-transport{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10.5px;border:.5px solid var(--dsw-alias-border-l2);border-radius:5px;padding:1px 6px;white-space:nowrap;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}
.mcpi-transportUnknown{border-style:dashed;color:var(--dsw-alias-label-tertiary)}
.mcpi-layer{font-size:10.5px;border-radius:5px;padding:1px 6px;white-space:nowrap;border:.5px solid transparent}
.mcpi-layer-profile{color:var(--dsw-alias-brand-primary);background:color-mix(in srgb, var(--dsw-alias-brand-primary) 11%, transparent)}
.mcpi-layer-home{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 11%, transparent)}
.mcpi-layer-bundle{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1)}
.mcpi-layer-unknown{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2);border-style:dashed;border-color:var(--dsw-alias-border-l2)}
.mcpi-toolCount{display:inline-block;min-width:20px;text-align:center;font-size:11px;border-radius:999px;padding:1px 6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.mcpi-toolCountOn{background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 13%, transparent);color:var(--dsw-alias-state-success-primary)}
.mcpi-statusPill{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.mcpi-statusPillOn{color:var(--dsw-alias-state-success-primary)}
.mcpi-dot{width:6px;height:6px;border-radius:50%;background:currentColor;display:inline-block;flex:none}
.mcpi-chip{display:inline-flex;align-items:center;gap:5px;font-size:11px;border-radius:999px;padding:1px 8px;white-space:nowrap;border:.5px solid currentColor}
.mcpi-chip-none{color:var(--dsw-alias-state-success-primary)}
.mcpi-chip-warning{color:var(--dsw-alias-state-warn-primary)}
.mcpi-chip-high{color:var(--dsw-alias-state-error-primary)}
.mcpi-chip-blocked{color:var(--dsw-alias-state-error-primary);border-style:dashed}
.mcpi-chipSoft{font-family:inherit;border-radius:5px;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);padding:1px 7px;font-size:11px;max-width:280px;overflow:hidden;text-overflow:ellipsis;display:inline-block;white-space:nowrap}
.mcpi-chipMono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10.5px}
.mcpi-chipTool{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb, var(--dsw-alias-brand-primary) 35%, transparent)}
.mcpi-chipRow{display:flex;flex-wrap:wrap;gap:5px;margin-top:1px}
.mcpi-ack{display:flex;align-items:flex-start;gap:6px;margin-top:8px;font-size:11.5px;color:var(--dsw-alias-state-warn-primary);cursor:pointer;max-width:340px}
.mcpi-errorText{color:var(--dsw-alias-state-error-primary);font-size:12.5px;margin:0}
.mcpi-warnText{color:var(--dsw-alias-state-warn-primary);font-size:12.5px;margin:0}
.mcpi-okText{color:var(--dsw-alias-state-success-primary);font-size:11.5px}
.mcpi-muted{color:var(--dsw-alias-label-tertiary);font-size:12px}
.mcpi-preWrap{white-space:pre-wrap;word-break:break-word}
.mcpi-detailRow td{background:color-mix(in srgb, var(--dsw-alias-brand-primary) 4%, var(--dsw-alias-bg-layer-2));padding:12px 14px}
.mcpi-detailGrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px 18px}
.mcpi-detail{min-width:0;display:flex;flex-direction:column;gap:3px}
.mcpi-detailLabel{font-size:11px;color:var(--dsw-alias-label-tertiary);text-transform:uppercase;letter-spacing:.03em}
.mcpi-detailValue{min-width:0;font-size:12px}
.mcpi-chevron{transition:transform .15s ease;color:var(--dsw-alias-label-tertiary)}
.mcpi-chevronOpen{transform:rotate(90deg)}
.mcpi-chevronButton{display:inline-flex;border:0;background:transparent;cursor:pointer;padding:2px;border-radius:5px}
.mcpi-chevronButton:hover{background:var(--dsw-alias-bg-layer-2)}
.mcpi-scrollHint{display:flex;align-items:center;gap:6px;margin:0;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.mcpi-empty{display:flex;flex-direction:column;align-items:center;gap:8px;border:.5px dashed var(--dsw-alias-border-l2);border-radius:10px;padding:34px 16px;text-align:center}
.mcpi-emptyIcon{width:26px;height:26px;color:var(--dsw-alias-label-tertiary)}
.mcpi-emptyTitle{font-size:13.5px;font-weight:600}
.mcpi-steps{display:flex;align-items:center;gap:8px;padding:2px 2px 0}
.mcpi-step{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.mcpi-stepDot{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);font-size:11px;font-variant-numeric:tabular-nums}
.mcpi-stepActive{color:var(--dsw-alias-label-primary);font-weight:600}
.mcpi-stepActive .mcpi-stepDot{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent)}
.mcpi-stepDone{color:var(--dsw-alias-state-success-primary)}
.mcpi-stepDone .mcpi-stepDot{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent)}
.mcpi-stepLine{flex:0 0 34px;height:.5px;background:var(--dsw-alias-border-l2)}
.mcpi-stepLineDone{background:var(--dsw-alias-state-success-primary)}
.mcpi-successHead{display:flex;align-items:center;gap:12px}
.mcpi-successIcon{display:inline-flex;align-items:center;justify-content:center;width:38px;height:38px;border-radius:50%;background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent);color:var(--dsw-alias-state-success-primary);flex:none}
.mcpi-successIcon .mcpi-icon{width:20px;height:20px}
.mcpi-kv{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;font-size:12.5px}
.mcpi-kvLabel{color:var(--dsw-alias-label-tertiary);flex:none;min-width:72px}
.mcpi-done{border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 45%, var(--dsw-alias-border-l1))}
.mcpi-doneMessage{margin:0;font-size:12.5px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word}
.mcpi-error{border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, var(--dsw-alias-border-l1))}
`.trim();
