export interface TicketProposal {
  meetingId: string;
  title: string;
  description: string;
  sourceExcerpt: string | null;
}

export interface MulticaTicket {
  id: string;
  url: string | null;
}
