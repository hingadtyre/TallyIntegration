# Implementation context and documentation maintenance

Use the repository docs as implementation inputs and keep affected guidance current in the same change. This workflow applies to features, bug fixes, refactors, configuration, deployment and documentation work. Read-only questions and status checks do not require documentation edits.

## Before implementation

1. Read [README](../../README.md) for delivered capabilities and limitations, and [CONTRIBUTING](../../CONTRIBUTING.md) for the development workflow and module map.
2. Follow [domain guidance](domain.md): read the glossary and relevant architecture decision records. Read the relevant sections of the [approved architecture](../design/architecture.md) before changing product behavior or module boundaries. Read the referenced GitHub issue/spec when the task supplies one.
3. Use the context map below to load the task-specific setup and integration notes. Inspect the corresponding source and tests before treating a capability as implemented.
4. Resolve differences explicitly. Current user instructions take precedence over repository docs. Apply decisions already authorized in the task and update their documentation; ask only about unresolved material product choices. If code differs from the approved design, identify whether the task fixes that gap or changes the design. Preserve the distinction between a bug, an approved future feature and an intentionally changed requirement.

## Context map and update triggers

| Document                                                              | Consult and update when the change affects                                                                                                                                                                          |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [README](../../README.md)                                             | Available features, limitations, startup/verification commands or operational status. This is the entry point for what the current build delivers.                                                                  |
| [CONTRIBUTING](../../CONTRIBUTING.md)                                 | Developer setup, module responsibilities, code conventions, validation or database development.                                                                                                                     |
| [Approved architecture](../design/architecture.md)                    | Product rules, company/account/location scope, proposals, publication, automation, allowances, recovery or architectural boundaries. This describes the intended behavior, including unfinished features.           |
| [GLOSSARY](../../GLOSSARY.md) and [ADRs](../adr/)                     | Domain meaning or a lasting architecture decision. Record the rationale for a changed decision and preserve its history; use a superseding ADR when appropriate.                                                    |
| [Customer setup](../customer-setup.md)                                | Installation, runtime requirements, account connection, packaging, data paths, upgrades, backup/restore or daily use. Keep affected guidance in [CustomerSetup.tsx](../../src/client/CustomerSetup.tsx) consistent. |
| [Tally validation](../integration/tally-validation.md)                | Tally transport, company/item identity, dates, units, godowns, compatibility or live verification evidence.                                                                                                         |
| [Flipkart validation](../integration/flipkart-validation.md)          | Authentication, seller/location identity, listing/pack evidence, orders, inventory writes, retries or verified platform behavior.                                                                                   |
| [Onboarding research](../integration/customer-onboarding-research.md) | The supporting official-source evidence for Tally/Flipkart onboarding changes. Keep the source and verification date explicit.                                                                                      |
| [Design interview](../design/inventory-sync.md)                       | Historical decisions or evidence needed to understand a rule. Maintain current requirements in the approved architecture; keep historical observations clearly dated or labelled.                                   |
| [Agent guidance](../../AGENTS.md) and linked instructions             | A reusable workflow or documentation-routing rule changes. Keep the root file short and put detailed rules in the existing relevant guide.                                                                          |

## During the change

- Update the existing authoritative document and affected user-facing guidance alongside the implementation. Add a new document only when it has a distinct purpose and a discovery link from an existing entry point.
- Review documentation impact for each meaningful change; edit only affected documents. An internal fix that preserves documented behavior may need no documentation change.
- Keep approved, implemented, locally tested and live-verified states distinct. A settings field, successful mock test or API example does not establish a working customer integration. Promote a capability in the current-status docs only when the implementation and required verification support that claim.
- Source package versions, commands, paths and defaults from their declarations. Check documented examples when those declarations change, including pinned customer installation baselines when preparing a new customer release.
- Record new external integration evidence with its official source, date, relevant version/environment and remaining uncertainty. Preserve historical observations rather than silently presenting them as fresh verification. Keep credentials and customer payloads out of docs.
- Preserve accepted business decisions while updating delivery status. A documentation cleanup alone does not authorize new product behavior, customer account changes or live marketplace writes.

## Before handoff

1. Check the context map against the completed change. Update each affected authoritative document and any affected customer/in-app instructions, including removal or correction of stale limitations and approval gates.
2. Verify changed commands and claims against source/configuration and the checks actually performed. Check Markdown formatting and affected relative links. For documentation-only work, these checks are sufficient unless a changed executable example or discovered defect justifies more testing.
3. Include documentation updates with the implementation in the same proposed commit/PR when that delivery is requested. Follow the task's existing authorization for commits and publication.
4. In the implementation handoff or PR, briefly name the docs updated. If none changed, give a short reason, such as “internal retry fix; documented behavior and setup unchanged.” Record any remaining verification limits without claiming completion.
