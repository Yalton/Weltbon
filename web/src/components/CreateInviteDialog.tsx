/**
 * TEMPORARY PLACEHOLDER — plan 13-04 worktree.
 *
 * The canonical CreateInviteDialog is owned by sibling Wave 3 plan 13-05.
 * Plan 13-05 lands the real two-phase dialog (mint form → one-time-reveal modal).
 * This file exists only so that plan 13-04's worktree can typecheck and run its
 * test suite in isolation; on merge, the orchestrator must resolve the inevitable
 * add/add conflict by taking plan 13-05's version. Do NOT extend this stub.
 */

import type { ReactNode } from 'react';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children?: ReactNode;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function CreateInviteDialog(_props: Props) {
  return null;
}

export default CreateInviteDialog;
