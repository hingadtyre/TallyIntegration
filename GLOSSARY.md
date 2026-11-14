# Marketplace Inventory Synchronization

The language used to describe Tally stock and the marketplace listings supplied by that stock.

## Language

**Stockbridge customer**:
A business using Stockbridge to synchronize its Tally inventory with its marketplace seller accounts, such as HingadTyre.
_Avoid_: Marketplace buyer

**Stockbridge provider**:
The operator offering and maintaining Stockbridge for customers.

**Customer authorization**:
A customer's permission for a registered application to access a particular marketplace seller account. This permission is separate from approval to publish a stock change.

**Seller-owned application**:
A marketplace API application registered by a seller for that seller's own account and use, distinct from a provider application authorized by multiple customers.

**Tally company**:
A distinct set of business records maintained in Tally, containing its own stock items and stock balances.

**Stock item**:
A product recorded within a particular Tally company. Identical names in different companies do not establish that they represent the same physical stock.
_Avoid_: Tally listing

**Marketplace**:
A selling platform, such as Flipkart, on which a seller offers products.

**Seller account**:
A seller's account on a particular marketplace. One marketplace can have multiple seller accounts.

**Marketplace listing**:
A seller's offer for a product on a marketplace, identified in the context of its seller account. Several listings may draw from the same Tally stock item.

**Seller SKU**:
A seller-assigned code identifying an offered product within its seller account. The same text in different accounts need not identify the same offer.

**Stock mapping**:
The association identifying which Tally stock item supplies a marketplace listing.
_Avoid_: Creating a Tally product, creating a marketplace listing

**Pack size**:
The number of physical base units consumed by one sold listing unit, such as two tyres for a pair listing. A shipping package is not necessarily a product pack.

**Shipping package count**:
The number of physical packages configured for one listing unit. For this seller's tyres, one tyre is shipped per package, making a verified package count evidence of pack size; this equivalence does not automatically apply to other categories or sellers.

**Fulfillable pack quantity**:
The number of complete packs that can be supplied from a stock item's physical quantity, before applying any marketplace advertising policy.

**Advertised stock floor**:
A minimum marketplace quantity applied when at least one complete pack is physically available. For the agreed Flipkart tyre policy the floor is five; zero fulfillable packs still results in zero advertised stock.

**Low physical stock**:
A stock balance at or below a configured threshold in base units. It is determined from physical stock, not the advertised marketplace quantity.

**Automation pause**:
A deliberate stop of all automatic stock publication for a marketplace listing, including zero updates, maintained until the seller resumes automation. Its underlying stock policy remains in place; observations and allowance accounting continue, and reviewed manual publication is still possible.
_Avoid_: Disabled listing, deleted mapping

**Manual override**:
A seller-chosen adjustment to a listing's normal calculated stock behavior. Its effect must be stated explicitly, such as a sales allowance, rather than assuming that editing a quantity pauses automation.

**Sales allowance**:
A finite number of additional listing units the seller permits to be sold before that listing is advertised as out of stock. A listing unit is one complete pack, not necessarily one physical tyre.
_Avoid_: Stock cap, maximum displayed quantity, automation lock

**Remaining allowance**:
The unconsumed portion of a sales allowance. Physical stock availability and remaining allowance are separate constraints; purchases, cancellations and returns do not restore an exhausted allowance without the seller's explicit action.

**Manual out-of-stock hold**:
A seller instruction to keep a specific marketplace listing at zero advertised stock, even when its mapped Tally item has stock. It remains until the seller grants allowance or returns the listing to normal automatic calculation.
_Avoid_: Deleting the listing, zeroing Tally stock, pausing all updates

**Observed marketplace stock**:
The stock quantity last read from a marketplace for a listing at a particular seller location, together with the time it was read.
_Avoid_: Live stock when the value has not just been verified

**Proposed stock**:
A quantity prepared for review before publication to a marketplace. It may differ from observed marketplace stock.

**Stock publication**:
An attempt to send a proposed stock quantity to a marketplace. A sent request and a confirmed marketplace update are distinct outcomes.

**Unmapped stock item**:
A Tally stock item with no associated listing in the marketplace account currently being viewed.
