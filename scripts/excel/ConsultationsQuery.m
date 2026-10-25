// ============================================================================
// MWANGI WANGONDU & ASSOCIATES — POWER QUERY (M) INTEGRATION SPECIFICATION
// Target Application: Microsoft Excel (Desktop / Microsoft 365 / OneDrive)
// Authoritative Source: Mwangi Wangondu & Associates Google Sheets Ledger
// ============================================================================
// INSTRUCTIONS TO CONFIGURE IN MICROSOFT EXCEL:
// 1. In Excel, go to the "Data" tab -> "Get Data" -> "From Other Sources" -> "Blank Query".
// 2. Click "Advanced Editor" in the Query Editor window.
// 3. Paste this entire M code block into the Advanced Editor.
// 4. Update the "SourceUrl" parameter below if your Google Sheet published URL changes.
// 5. Click "Done", then "Close & Load" into an Excel Table.
// 6. Under Data -> Queries & Connections -> Query Properties, check:
//    - "Refresh every 5 minutes"
//    - "Enable background refresh"
// ============================================================================

let
    // 1. SOURCE URL: Published CSV feed from your Google Sheet (or secure internal endpoint)
    SourceUrl = "https://docs.google.com/spreadsheets/d/e/2PACX-1vTlej4TP7UJGdgxQa_Wo_sZwNY86L_mTByF5lzov2v8gFMNFq4Z7Mc2xO65lKbU-z2KDsSv6SJ7Ezkq/pub?output=csv",

    // 2. FETCH DOCUMENT: Uses QuoteStyle.Csv and UTF-8 encoding (prevents row breaks on commas/quotes in messages)
    SourceData = Csv.Document(
        Web.Contents(SourceUrl),
        [
            Delimiter = ",",
            Columns = 14,
            Encoding = 65001,
            QuoteStyle = QuoteStyle.Csv
        ]
    ),

    // 3. PROMOTE HEADERS: Automatically sets row 1 as table column names
    PromotedHeaders = Table.PromoteHeaders(SourceData, [PromoteAllScalars = true]),

    // 4. CLEAN AND TRIM TEXT: Removes leading/trailing whitespace across all text columns
    CleanedColumns = Table.TransformColumns(PromotedHeaders, {
        {"Reference Code", Text.Trim, type text},
        {"Full Name", Text.Trim, type text},
        {"Email Address", Text.Trim, type text},
        {"Telephone / WhatsApp", Text.Trim, type text}
    }),

    // 5. ENFORCE DATA TYPES: Preserves string format for telephone numbers (stops Excel stripping leading 0 or +)
    TypedTable = Table.TransformColumnTypes(CleanedColumns, {
        {"Reference Code", type text},
        {"Timestamp (UTC+3)", type text},
        {"Full Name", type text},
        {"Email Address", type text},
        {"Telephone / WhatsApp", type text},
        {"Company / Organization", type text},
        {"Industry Sector", type text},
        {"Primary Service Area", type text},
        {"Consultation Format", type text},
        {"Preferred Date", type text},
        {"Time Window", type text},
        {"Scope Description", type text},
        {"Booking Status", type text},
        {"Source Channel", type text}
    }),

    // 6. DEDUPLICATION: Ensures every booking reference appears exactly once in Excel
    DeduplicatedRows = Table.Distinct(TypedTable, {"Reference Code"}),

    // 7. SORTING: Orders table chronologically with newest bookings at the top
    SortedByTimestamp = Table.Sort(DeduplicatedRows, {{"Timestamp (UTC+3)", Order.Descending}})
in
    SortedByTimestamp
