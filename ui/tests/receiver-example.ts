// Reference packets for the four-step instructor worksheet.
export type ReceiverSnapshot = {
  receipt: string | null;
  body: string;
  bodySent: boolean;
};

type ReceiverStep = {
  label: string;
  input: string;
  explanation: string;
  vulnerable: ReceiverSnapshot;
  protected: ReceiverSnapshot;
};

const unlockEvent = "Unlock · counter 9";
const freshUnlock: ReceiverSnapshot = {
  receipt: "0100000000090001", body: "0000000000000101", bodySent: true,
};
const cabinRelock: ReceiverSnapshot = {
  receipt: null, body: "0000000100000002", bodySent: true,
};

export const receiverSteps: readonly ReceiverStep[] = [
  {
    label: "Fresh unlock", input: unlockEvent,
    explanation: "Both cars start locked. The first fob press unlocks both. Their doors stay closed until someone pulls a handle.",
    vulnerable: freshUnlock, protected: freshUnlock,
  },
  {
    label: "Cabin relock", input: "Cabin lock switch",
    explanation: "Both drivers lock their cars from the cabin. This changes the body status while preserving the earlier fob event.",
    vulnerable: cabinRelock, protected: cabinRelock,
  },
  {
    label: "Same old unlock", input: unlockEvent,
    explanation: "Both receivers see the original unlock again. The protected receiver remembers counter 9. Compare B0 (decision) and B6 (lock) in their replies.",
    vulnerable: {receipt: "0100000000090003", body: "0000000000000103", bodySent: true},
    protected: {receipt: "0200000000090102", body: cabinRelock.body, bodySent: false},
  },
  {
    label: "Try both handles", input: "Pull each left door handle",
    explanation: "The vulnerable car’s left door opens and its cabin light comes on. The protected car’s lock holds the door closed.",
    vulnerable: {receipt: null, body: "0000010000010004", bodySent: true},
    protected: {receipt: null, body: cabinRelock.body, bodySent: false},
  },
];
