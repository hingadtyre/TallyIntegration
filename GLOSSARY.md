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

**FSN (Flipkart Serial Number)**

Flipkart’s product ID. Multiple sellers can offer the product identified by one FSN.

**Flipkart listing ID**

Flipkart’s identifier for a seller’s offer. Stockbridge also uses the seller location to identify which warehouse stock a mapping supplies.

**Stock mapping**:
The association identifying which Tally stock item supplies a marketplace listing.
_Avoid_: Creating a Tally product, creating a marketplace listing

**Pack size**:
The number of base units of the mapped Tally stock item consumed by one sold listing unit. For a pair of tyres stocked individually, the pack size is two. The seller calls this **Set of** in Inventory.

**Catalogue set quantity**:
The number of items a buyer receives when purchasing one unit of a particular marketplace product variant. Flipkart labels this `Set of` for vehicle tyres and `Number of Two Wheeler Tyre` for two-wheeler tyres. A pair of tyres has a catalogue set quantity of two. Its pack size is two if Tally counts individual tyres and one if Tally counts pairs.

**Shipping package count**:
The number of shipping parcels configured for one listing unit. A parcel may contain several items, and a single item may ship in multiple parcels.

**Physical package**:
An individually handled parcel in a delivery or return. One sold listing unit can occupy several physical packages, which may arrive separately.
_Avoid_: Listing quantity, product pack

**Courier return**:
Goods sent back to the seller because delivery to the marketplace buyer was unsuccessful, also called return to origin (RTO).

**Customer return**:
Goods sent back after the marketplace buyer received them and requested a return.

**Physical receipt**:
The seller's confirmation that an individual returned package has arrived and has been checked. A marketplace or courier delivery status alone does not establish physical receipt.
_Avoid_: Delivered when only a tracking status is known

**Fulfillable pack quantity**:
The number of complete packs that can be supplied from the available Tally units before applying a marketplace advertising policy. For calculated stock sync, available units are the verified Tally balance less covered Flipkart sales whose stock deduction has yet to be matched in Tally, with a lower bound of zero.

**Advertised stock floor**:
A minimum marketplace quantity applied when at least one complete pack is physically available. For the agreed Flipkart tyre policy the floor is five; zero fulfillable packs still results in zero advertised stock.

**Low physical stock**:
A stock balance at or below a configured threshold in base units. It is determined from physical stock, not the advertised marketplace quantity.

**Company sync**:
The seller’s permission for Stockbridge to publish automatic stock updates for eligible listings supplied by one Tally company, across its seller accounts. It covers each listing as soon as its stock and destination can be verified.

**Listing trial**:
A seller-approved publication of the calculated stock for one mapped listing at one seller location while company sync is off.

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

**Order-to-bill match**:
Evidence that a Flipkart order item was billed through the selected Tally company and sales ledger for its mapped item and units. A ledger entry identifies a possible sales channel. A matching order reference or explicit seller confirmation links the bill to the order item.

**Unbilled stock reservation**:
The Tally units already committed to a verified Flipkart order but still awaiting a matching stock deduction in Tally. Every listing supplied by the same stock item draws on the remaining available units.

**Stock recovery review**:
A seller’s comparison of the current marketplace quantity with the newly calculated available stock after an earlier update had an uncertain outcome. Recovery requires evidence that the earlier request can no longer change stock.

**Direct stock update**:
A seller instruction to set an absolute marketplace stock quantity for a specified listing and seller location. It is distinct from changing physical Tally stock or granting a sales allowance.

**Unmapped stock item**:
A Tally stock item with no associated listing in the marketplace account currently being viewed.

**Unmapped marketplace listing**:
A marketplace listing with no association to a Tally stock item. It still belongs to its seller account and can exist independently of Tally synchronization.
