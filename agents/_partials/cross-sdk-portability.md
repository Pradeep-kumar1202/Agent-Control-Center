## Cross-SDK portability knowledge

- `hyperswitch-client-core` mobile renders many payment-method forms from backend-provided field descriptions. A dedicated web input such as BLIK code, PIX, VPA, document number, crypto network, or gift-card form often has no one-to-one mobile component to create.
- Mobile obtains its available payment-method list from backend responses. A static web payment-method registry/list is therefore not something to mirror into mobile source.
- Native-only `ios/` or `android/` changes do not have a direct web equivalent. Port the shared behavior only when the PR also establishes a platform-independent contract.
- Architecture differs between the SDKs. Port observable behavior and public contracts, never file layout or source text verbatim.
- Mark a change `partial` when some behavior is portable but source-only files must be skipped. Mark it `no` only when no meaningful target-SDK behavior remains.
