---
name: Imported setup constraints
description: Scope and an environment-specific package-manager issue encountered during import setup.
---

Keep import setup limited to running the existing project, without replacing its stack or external database.

**Why:** The user chose to get the imported project running, not to restructure or migrate it.

**How to apply:** Ask separately before broad architectural changes or database replacement.

Automatic pnpm version management triggered recursive package-manager installation failures in this Replit environment, including process exhaustion. Command-line and environment-variable attempts to disable it did not prevent the recursion; project configuration did.

**Why:** Repeated self-installation prevented even version checks from completing and exhausted process resources.

**How to apply:** Prefer the provisioned pnpm runtime during setup and avoid re-enabling automatic version management without checking compatibility.
