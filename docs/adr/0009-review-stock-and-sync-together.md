# Review stock and sync changes together

On 28 November 2026 the seller chose to review each destination’s quantity and sync action together. This extends the [manual zero decision](0007-manual-zero-pauses-sync.md) to positive manual Inventory quantities. The former **Update once** choice allowed a subsequent Tally sync to replace stock the seller had just entered.

Typing and saving a quantity or choosing **Set to zero** prepares a manual proposal. Publish pauses that destination when it accepts the reviewed edit for submission or verifies that its quantity already matches. A submitted request with an uncertain result keeps the pause. Existing allowances and the company’s automatic updates setting remain separate.

**Calculate** expresses a fresh choice for the selected destinations, or for every filtered destination across pages when the selection is empty. A successful calculation replaces the saved draft. For a paused destination it records the seller’s intent to resume. Publish verifies the calculated quantity against fresh evidence before applying that resume. A quantity match can therefore still require review. Background checks preserve manual drafts and cannot grant permission to resume.

**Discard** in review clears the captured row’s saved proposal and its pending sync action. Concurrent edits require a fresh review. Normal restart preserves the saved proposal and its intent. Offline restore clears resume instructions and keeps recovered destinations paused.
