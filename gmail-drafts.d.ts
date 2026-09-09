export type GmailApi = (path: string, opts?: RequestInit) => Promise<any>;

export interface ReplyResult { draftId: string; to: string; subject: string; from?: string }
export interface ComposeResult { draftId: string; to: string; subject: string }
export interface DraftListItem { draft_id: string; thread_id?: string | null; to?: string; subject?: string }
export interface DraftListResult { drafts: DraftListItem[]; total: number }
export interface DraftGetResult { draft_id: string; thread_id: string | null; from: string; to: string; subject: string; body: string }
export interface UpdateResult { draftId: string; threadId: string | null }

export interface DraftOps {
  reply(threadId: string, bodyText: string): Promise<ReplyResult>;
  compose(to: string, subject: string, bodyText: string): Promise<ComposeResult>;
  list(): Promise<DraftListResult>;
  get(draftId: string): Promise<DraftGetResult>;
  update(draftId: string, bodyText: string, to?: string, subject?: string): Promise<UpdateResult>;
  delete(draftId: string): Promise<void>;
}

export function createDraftOps(api: GmailApi): DraftOps;
export function gmailRestApi(
  getToken: () => Promise<string> | string,
  opts?: { fetch?: typeof fetch; base?: string },
): GmailApi;
export function gmailRawMime(headers: Array<[string, string]>, bodyText: string): string;
export function mailHeader(msg: any, name: string): string;
export function mailPartText(payload: any, want: string): string;
export function mailHtmlToText(html: string): string;
export function mailBodyText(payload: any): string;
