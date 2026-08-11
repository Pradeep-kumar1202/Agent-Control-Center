ReScript-specific pitfalls (also see spec.reScriptGotchas):
- Adding a field to a record → EVERY constructor of that record must include it.
  Grep for the record type name BEFORE editing to find all construction sites.
- Optional fields: option<T> with Some(x) / None. Never undefined or null.
- New variants → every switch on that type must be exhaustive.
- Use Belt.Option.getWithDefault, not Option.getOrElse.
- open ModuleName can shadow built-ins — prefer Belt.* qualified names.
