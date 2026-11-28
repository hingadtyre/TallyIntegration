# A manual zero pauses Tally sync for one listing and location

The [28 November review decision](0009-review-stock-and-sync-together.md) extends this rule to all manual Inventory quantities and adds reviewed resumption through Calculate and Publish.

On 21 November 2026 the seller chose one meaning for a manually published zero in Inventory and Marketplaces. Stockbridge records the pause for that seller, listing and location when accepting the update for submission, including when Flipkart already shows zero. A draft can be saved or discarded before that decision. Other listings supplied by the same Tally item continue syncing.

Previously an Inventory zero could keep enforcing zero. If another operator later increased stock on Flipkart, Stockbridge could undo that change. A paused destination leaves the marketplace quantity under the seller’s control until **Resume sync**. Resume replaces that destination’s saved draft with the freshly calculated quantity. Otherwise an old manual zero would appear to be the quantity about to go to Flipkart. When the calculation is blocked, the seller sees the reason and an empty proposal. The next eligible sync checks what to publish using fresh available stock and any existing sales allowance. A zero calculated from insufficient stock leaves sync enabled so a restock can reopen the listing.

On upgrade or restore, convert the previous manual zero policy into a paused Auto listing. Preserve its last observation and any unresolved marketplace attempt. The conversion sends no marketplace request.
