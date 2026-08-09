# Type Alias: CashuAuctionKeysetPolicy

> **CashuAuctionKeysetPolicy** = `object`

Operator commitment that a mint output keyset will remain active through a
Unix timestamp. NUT-02 does not advertise a future inactivation time, so an
auction must not infer this guarantee from `active` or `final_expiry`.

## Properties

### activeUntil

> **activeUntil**: `number`

***

### keysetId

> **keysetId**: `string`
