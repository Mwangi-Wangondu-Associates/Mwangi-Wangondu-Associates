// ============================================================================
// MWANGI WANGONDU & ASSOCIATES — POWER QUERY (M) INTEGRATION SPECIFICATION
// Target Application: Microsoft Excel (Desktop / Microsoft 365 / OneDrive)
// Authoritative Source: Private Mwangi Wangondu & Associates Consultations Ledger
// ============================================================================
// SECURITY & DATA PRIVACY NOTICE:
// Direct unauthenticated Power Query Web.Contents() to private Google Sheets is
// NOT SUPPORTED by Microsoft without public publishing (which breaches client confidentiality).
// DO NOT publish the Google Sheet to the web via "pub?output=csv".
//
// RECOMMENDED SECURE INTEGRATION ARCHITECTURES:
//
// [OPTION 1 - RECOMMENDED] Microsoft Power Automate Cloud Flow:
// 1. Create an automated cloud flow triggered when a new row is appended to the Google Sheet.
// 2. Action: "Insert row into an Excel Table" located in OneDrive / SharePoint:
//    "Mwangi Wangondu & Associates Consultations.xlsx" -> Table "ConsultationsTable".
// 3. This maintains real-time synchronization under end-to-end Microsoft 365 authentication
//    with ZERO public web exposure.
//
// [OPTION 2] Internal Secure CSV Sync / Local File Connection:
// 1. Maintain an authenticated export or sync file in your secure OneDrive folder:
//    e.g. "C:\Users\<User>\OneDrive - Mwangi Wangondu & Associates\Ledger\consultations_internal.csv"
// 2. Point this Power Query script to the internal OneDrive file path or SharePoint document library.
// ============================================================================

let
    // 1. SECURE SOURCE PATH: Configure to your local OneDrive sync folder or SharePoint URL
    // (Replace with your actual local OneDrive path or SharePoint File URL)
    SourcePath = "C:\Users\User\OneDrive - Mwangi Wangondu & Associates\Ledger\consultations_internal.csv",

    // 2. LOAD DATA: Uses Csv.Document with QuoteStyle.Csv to handle internal commas, quotes, and newlines
    SourceData = Csv.Document(
        File.Contents(SourcePath),
        [
            Delimiter = ",",
            Columns = 14,
            Encoding = 65001,
            QuoteStyle = QuoteStyle.Csv
        ]
    ),

    // 3. PROMOTE HEADERS: Uses row 1 as table column names
    PromotedHeaders = Table.PromoteHeaders(SourceData, [PromoteAllScalars = true]),

    // 4. CLEAN AND TRIM TEXT: Strips leading/trailing whitespace across identity columns
    CleanedColumns = Table.TransformColumns(PromotedHeaders, {
        {"Reference Code", Text.Trim, type text},
        {"Full Name", Text.Trim, type text},
        {"Email Address", Text.Trim, type text},
        {"Telephone / WhatsApp", Text.Trim, type text}
    }),

    // 5. ENFORCE DATA TYPES: Preserves string format for phone numbers (prevents stripping leading + or 0)
    TypedTable = Table.TransformColumnTypes(CleanedColumns, {
        {"Reference Code", type text},
        {"Timestamp (UTC)", type text},
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

    // 6. DEDUPLICATION: Ensures every booking reference appears exactly once in the Excel ledger
    DeduplicatedRows = Table.Distinct(TypedTable, {"Reference Code"}),

    // 7. CHRONOLOGICAL SORT: Orders newest bookings at the top by UTC timestamp
    SortedByTimestamp = Table.Sort(DeduplicatedRows, {{"Timestamp (UTC)", Order.Descending}})
in
    SortedByTimestamp

