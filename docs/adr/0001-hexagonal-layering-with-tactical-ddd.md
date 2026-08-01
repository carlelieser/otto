# Hexagonal layering, tactical DDD vocabulary, no strategic DDD

---
Status: accepted
---

Otto is organised top-level by **layer** rather than by feature, following hexagonal architecture (Cockburn's ports and adapters): `domain/` imports nothing else in `src/`, `application/` imports domain and ports, `infrastructure/` implements ports, and only the composition root imports `infrastructure/`. Inside `domain/` we borrow *tactical* DDD vocabulary — entity, value object, aggregate, domain event, policy — because those names do real work. We adopt **none** of strategic DDD: no bounded contexts, no context map, no anti-corruption layers, because those exist to solve organisational problems (multiple teams meaning different things by the same word) that a solo project does not have.

The payoff we are buying is **testability, not swappability**. Database swaps almost never happen; being able to run the entire capture → inference → apply pipeline against in-memory adapters with no network is what makes the eval-set work in ADR-0006 possible at all. Layer-first rather than feature-first is justified specifically because Otto's layers have genuinely different dependency rules — most notably ADR-0003 — and a feature-first tree cannot express those rules structurally.

## Considered Options

- **Feature-first tree** (`src/people/`, `src/projects/`) — rejected: cannot encode "inference never writes", which is the constraint most worth enforcing.
- **Flatter, conventional layering** — defensible for a solo project of this size, and would be the right call if the inference/deterministic split did not exist. It does, so the extra structure earns its place.
- **Full DDD including strategic patterns** — rejected: ceremony without the problem it was invented for.

## Consequences

- The inward dependency rule decays silently under time pressure. It needs a lint rule (ADR-0003), not discipline.
- `domain/` being thin would be real information, not a neutral outcome: it would mean we built an ingestion pipeline rather than a knowledge model. ADR-0004 is the main reason we expect it to be rich instead.
