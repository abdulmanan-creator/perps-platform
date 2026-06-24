# Privy Onboarding Capability Audit

Source of truth for Agent.trade onboarding and funding copy. This reflects the
current repo wiring, not every capability Privy may support.

| Capability | Current repo status | Can claim in MVP? | Requirements before claiming | Notes |
| --- | --- | --- | --- | --- |
| Email login | Wired behind Privy env | Yes, when configured | `NEXT_PUBLIC_PRIVY_APP_ID`; email auth enabled in Privy dashboard | Provider config uses `loginMethods: ["email", "google", "wallet"]`. |
| Google login | Wired behind Privy env | Yes, when configured | `NEXT_PUBLIC_PRIVY_APP_ID`; Google OAuth enabled in Privy dashboard | Server/user copy may show the Google email when present. |
| Wallet login | Wired behind Privy env | Yes, when configured | `NEXT_PUBLIC_PRIVY_APP_ID`; wallet auth enabled in Privy dashboard | Existing-wallet login is available through the Privy modal. |
| Embedded wallet | Wired behind Privy env | Yes, when configured | `NEXT_PUBLIC_PRIVY_APP_ID`; embedded wallets enabled in Privy dashboard | App requests `createOnLogin: "users-without-wallets"` and prefers Privy embedded wallets. |
| SMS | SDK-supported, not wired | No | Add provider config, dashboard SMS auth, QA, and copy review | Do not mention SMS login in product copy today. |
| Apple login | SDK-supported, not wired | No | Add provider config, Apple OAuth setup, dashboard auth, QA, and copy review | Do not mention Apple login in product copy today. |
| Passkeys | SDK-supported, not wired | No | Product/security decision, provider config, passkey flow wiring, QA, and copy review | Do not mention passkey login in product copy today. |
| Debit/credit card | Privy funding may support provider-dependent card flows; not enabled by default | No | Choose provider, complete provider/KYC/legal setup, enable `NEXT_PUBLIC_AGENT_TRADE_ENABLE_PRIVY_FUNDING`, and verify end-to-end | Do not claim card support until the exact provider and regions are validated. |
| ACH/bank transfer | Provider-dependent, not wired as an app claim | No | Provider support, KYC, region review, legal approval, and end-to-end QA | Do not claim bank transfer support today. |
| Apple Pay / Google Pay | Not present as explicit app capability | No | Provider/device support, legal review, explicit QA, and copy approval | Do not name these methods until verified with the chosen provider. |
| Crypto deposit address | Not present | No | Separate deposit-address flow and Hyperliquid account-readiness integration | Current app does not provide a generic crypto deposit address. |
| Hyperliquid Bridge2 deposit | Legacy/default-off compatibility path | No, not generally | `NEXT_PUBLIC_AGENT_TRADE_ENABLE_HL_BRIDGE_DEPOSIT=true`, legacy approvals enabled, live eligibility, internal approval, and legal/compliance review | Must be described as legacy/internal compatibility, not normal MVP funding. |
| Generic Privy funding | Hook wired, default-off | Only as planned/provider-dependent | `NEXT_PUBLIC_AGENT_TRADE_ENABLE_PRIVY_FUNDING=true`, Privy env, connected wallet, live eligibility, available hook, provider setup, and legal/compliance approval | Funding a wallet is separate from depositing into Hyperliquid. |

## Copy Rules

- Claim only email, Google, existing-wallet login, and embedded-wallet creation,
  and only in environments with Privy configured.
- Say paper mode remains available for local/internal testing without Privy.
- Say funding/on-ramp is provider-dependent and disabled by default.
- Do not claim SMS, Apple login, passkeys, card, bank transfer, mobile-wallet
  payments, Coinbase, Meld, Stripe, generic deposit addresses, or generally
  available Hyperliquid Bridge2 deposits.
