export interface SheetAccount {
  accountId: string;
  accountName: string;
  website: string;
  accountOwner: string;
  potentialMrr: string;
  marketingRegion: string;
}

export interface AccountMetrics {
  contacts: number;
  opens: number;
  clicks: number;
}

export interface ContactRow {
  Id: string;
  Name: string;
  Title: string | null;
  Email: string | null;
  active: boolean | null;
  sfUrl: string;
}

export interface EmailEvent {
  taskId: string;
  person: string;
  contactId: string;
  campaign: string;
  date: string;
  sender: string | null;
  senderEmail: string | null;
  /** Full email body (sent/reply events only - "opened"/"clicked" are tracking pings with no body). */
  description: string | null;
  sfTaskUrl: string;
  sfContactUrl: string;
}
