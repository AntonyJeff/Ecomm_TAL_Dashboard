import { Modal } from "./Modal";

export function EmailContentModal({
  subject,
  sender,
  date,
  content,
  onClose,
}: {
  subject: string;
  sender: string | null;
  date: string;
  content: string;
  onClose: () => void;
}) {
  return (
    <Modal eyebrow="Email content" badge={date} title={subject} onClose={onClose}>
      {sender && <p className="modal-summary">Sent by {sender}</p>}
      <div className="email-content-body">{content}</div>
    </Modal>
  );
}
