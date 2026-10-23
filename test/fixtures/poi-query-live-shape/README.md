# POI live-shape replay

Captured read-only on 2026-10-24 from real online multi-candidate POI and public availability responses. The fixtures contain no account, login, or credential material. Response timestamps and server trace identifiers are removed; response status retains only the parser's required `Ack`.

Candidate order is preserved without trimming. Availability payloads are replayed through the production public availability parser. Fixed disambiguation replies only exercise candidate selection and do not claim live-model quality. These current captures include complete parent chains; the separate missing-parent regression covers incomplete historical metadata.
