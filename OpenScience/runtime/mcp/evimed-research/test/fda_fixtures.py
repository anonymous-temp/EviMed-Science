"""A small invented FDA snapshot for the approval-records tests: no real application, no benchmark value.

Every drug here is made up (ALPHAMOX, BETAKINE, GAMMAFLEX ...). The files are written in the formats of the real ones --
tilde-delimited Orange Book members, tab-delimited Drugs@FDA tables with their exact headers, two code pages -- so the
builder is exercised on the same parse as the real inputs.
"""

import hashlib
import io
import zipfile

import build_fda_approvals as builder

CRLF = "\r\n"


def _table(header, rows, delimiter):
    return CRLF.join([delimiter.join(header)] + [delimiter.join(row) for row in rows]) + CRLF


def orange_book_zip(extra_products=(), header_override=None):
    products = [
        # Ingredient, DF;Route, Trade_Name, Applicant, Strength, Appl_Type, Appl_No, Product_No, TE_Code, Approval_Date, RLD, RS, Type, Applicant_Full_Name
        ("ALPHAMOX HYDROCHLORIDE", "TABLET;ORAL", "ALPHAMOX", "ALPHA PHARMA", "EQ 10MG BASE", "N", "900001", "001", "", "Mar 5, 2010", "Yes", "No", "RX", "ALPHA PHARMACEUTICALS INC"),
        ("ALPHAMOX HYDROCHLORIDE", "TABLET;ORAL", "ALPHAMOX", "ALPHA PHARMA", "EQ 20MG BASE", "N", "900001", "002", "", "Jun 1, 2014", "Yes", "Yes", "RX", "ALPHA PHARMACEUTICALS INC"),
        ("ALPHAMOX HYDROCHLORIDE", "TABLET;ORAL", "ALPHAMOX HYDROCHLORIDE", "GENERICA", "EQ 10MG BASE", "A", "900002", "001", "AB", "Jan 9, 2020", "No", "No", "RX", "GENERICA LABS LLC"),
        ("ALPHAMOX HYDROCHLORIDE", "TABLET;ORAL", "ALPHAMOX HYDROCHLORIDE", "OTHERGEN", "EQ 10MG BASE", "A", "900005", "001", "AB", "Feb 2, 2021", "No", "No", "DISCN", "OTHERGEN PHARMA CORP"),
        ("GAMMAFLEX", "CREAM;TOPICAL", "GAMMAFLEX", "OLD CO", "1%", "N", "900006", "001", "", "Approved Prior to Jan 1, 1982", "Yes", "Yes", "RX", "OLD COMPANY LTD"),
        ("DELTAPIN; EPSILOCAINE", "INJECTABLE;INJECTION", "DELTACAIN", "DELTA", "5MG/ML;1MG/ML", "N", "900007", "001", "", "Oct 7, 2016", "Yes", "Yes", "RX", "DELTA BIOPHARMA INC"),
        *extra_products,
    ]
    patents = [
        # Appl_Type, Appl_No, Product_No, Patent_No, Patent_Expire_Date_Text, Drug_Substance_Flag, Drug_Product_Flag, Patent_Use_Code, Delist_Flag, Submission_Date
        ("N", "900001", "001", "7000001", "Aug 24, 2031", "Y", "Y", "U-9001", "", "Jun 27, 2013"),
        ("N", "900001", "002", "7000001", "Aug 24, 2031", "Y", "Y", "U-9001", "", "Jun 27, 2013"),
        ("N", "900001", "001", "7000001", "Aug 24, 2031", "Y", "Y", "U-9002", "", "Jun 27, 2013"),
        ("N", "900001", "001", "7000002", "Feb 1, 2029", "", "Y", "", "Y", ""),
        ("N", "900007", "001", "7000003", "Jan 15, 2027", "", "", "U-9003", "", "Mar 3, 2020"),
    ]
    exclusivity = [
        ("N", "900001", "001", "NCE", "Mar 5, 2015"),
        ("N", "900001", "002", "I-9100", "Jun 1, 2030"),
        ("N", "900007", "001", "ODE-9200", "Oct 7, 2023"),
    ]
    header = header_override or builder.ORANGE_BOOK_MEMBERS["products.txt"]
    return _zip({
        "products.txt": _table(header, products, "~"),
        "patent.txt": _table(builder.ORANGE_BOOK_MEMBERS["patent.txt"], patents, "~"),
        "exclusivity.txt": _table(builder.ORANGE_BOOK_MEMBERS["exclusivity.txt"], exclusivity, "~"),
    })


def drugs_at_fda_zip(drop=(), applications_extra=()):
    members = builder.DRUGS_AT_FDA_MEMBERS
    applications = [
        ("900001", "NDA", "", "ALPHA"),
        ("900002", "ANDA", "", "GENERICA"),
        ("900003", "BLA", "", "BETA"),
        ("900005", "ANDA", "", "OTHERGEN"),
        ("900006", "NDA", "Invented public note.", "OLD CO"),
        ("900007", "NDA", "", "DELTA"),
        *applications_extra,
    ]
    products = [
        ("900001", "001", "TABLET;ORAL", "EQ 10MG BASE", "1", "ALPHAMOX", "ALPHAMOX HYDROCHLORIDE", "0"),
        ("900001", "002", "TABLET;ORAL", "EQ 20MG BASE", "1", "ALPHAMOX", "ALPHAMOX HYDROCHLORIDE", "1"),
        ("900002", "001", "TABLET;ORAL", "EQ 10MG BASE", "0", "ALPHAMOX HYDROCHLORIDE", "ALPHAMOX HYDROCHLORIDE", "0"),
        ("900003", "001", "INJECTABLE;INJECTION", "100MG/ML", "1", "BETAKINE", "BETAKINEMAB", "1"),
        ("900005", "001", "TABLET;ORAL", "EQ 10MG BASE", "0", "ALPHAMOX HYDROCHLORIDE", "ALPHAMOX HYDROCHLORIDE", "0"),
        ("900006", "001", "CREAM;TOPICAL", "1%", "1", "GAMMAFLEX", "GAMMAFLEX", "1"),
        ("900007", "001", "INJECTABLE;INJECTION", "5MG/ML;1MG/ML", "1", "DELTACAIN", "DELTAPIN; EPSILOCAINE", "1"),
        # a product of an application the Applications table does not list, and an application nobody typed
        ("900008", "001", "TABLET;ORAL", "5MG", "0", "ORPHANIDE", "ORPHANIDE", "0"),
    ]
    submissions = [
        # ApplNo, SubmissionClassCodeID, SubmissionType, SubmissionNo, SubmissionStatus, SubmissionStatusDate, notes, ReviewPriority
        ("900001", "7", "ORIG      ", "1", "AP", "2010-03-05 00:00:00", "", "PRIORITY"),
        ("900001", "3", "SUPPL     ", "1", "AP", "2011-04-01 00:00:00", "", "STANDARD"),
        ("900001", "5", "SUPPL     ", "2", "AP", "2014-06-01 00:00:00", "", "STANDARD"),
        ("900001", "3", "SUPPL     ", "3", "AP", "2018-09-30 00:00:00", "", "STANDARD"),
        ("900001", "3", "SUPPL     ", "4", "CR", "2020-01-01 00:00:00", "", "STANDARD"),
        ("900001", "3", "SUPPL     ", "5", "AP", "2023-02-14 00:00:00", "", "STANDARD"),
        ("900002", "19", "ORIG      ", "1", "AP", "2020-01-09 00:00:00", "", ""),
        ("900003", "7", "ORIG      ", "1", "TA", "2019-05-05 00:00:00", "", "STANDARD"),
        ("900005", "19", "ORIG      ", "1", "AP", "2021-02-02 00:00:00", "", ""),
        ("900006", "3", "SUPPL     ", "7", "AP", "1995-08-08 00:00:00", "", ""),
        ("900007", "7", "ORIG      ", "1", "AP", "2016-10-07 00:00:00", "", "PRIORITY"),
        # an application that exists only in this table (about 1,450 old ones do in the real file)
        ("900009", "3", "SUPPL     ", "3", "AP", "1990-01-01 00:00:00", "", ""),
        ("900008", "19", "ORIG      ", "1", "AP", "2022-02-02 00:00:00", "", ""),
    ]
    tables = {
        "Applications.txt": _table(members["Applications.txt"], applications, "\t"),
        "Products.txt": _table(members["Products.txt"], products, "\t"),
        "Submissions.txt": _table(members["Submissions.txt"], submissions, "\t"),
        "SubmissionClass_Lookup.txt": _table(members["SubmissionClass_Lookup.txt"], [
            ("3", "LABELING", "Labeling"), ("5", "N/A", "Not Applicable"), ("7", "TYPE 1", "Type 1 - New Molecular Entity"), ("19", "UNKNOWN", ""),
        ], "\t"),
        "ActionTypes_Lookup.txt": _table(members["ActionTypes_Lookup.txt"], [
            ("8", "Efficacy-New Indication", "EFFICACY", "INDICATION"), ("19", "Labeling-Package Insert", "LABELING", "PI"), ("59", " -  - ", "", ""),
        ], "\t"),
        "Join_Submission_ActionTypes_Lookup.txt": _table(members["Join_Submission_ActionTypes_Lookup.txt"], [
            ("SUPPL     ", "1", "900001", "2", "8"), ("SUPPL     ", "2", "900001", "3", "19"), ("SUPPL     ", "3", "900001", "3", "59"),
        ], "\t"),
        "MarketingStatus.txt": _table(members["MarketingStatus.txt"], [
            ("1", "900001", "001"), ("1", "900001", "002"), ("1", "900002", "001"), ("3", "900005", "001"), ("1", "900006", "001"), ("1", "900007", "001"), ("4", "900003", "001"),
        ], "\t"),
        "MarketingStatus_Lookup.txt": _table(members["MarketingStatus_Lookup.txt"], [
            ("1", "Prescription"), ("2", "Over-the-counter"), ("3", "Discontinued"), ("4", "None (Tentative Approval)"),
        ], "\t"),
        "TE.txt": _table(members["TE.txt"], [("900002", "001", "1", "AB")], "\t"),
    }
    for name in drop:
        tables.pop(name)
    return _zip(tables)


def code_page(rows, table_ids=("example",)):
    tables = []
    chunks = [rows] if len(table_ids) == 1 else [rows[: len(rows) // 2], rows[len(rows) // 2:]]
    for table_id, chunk in zip(table_ids, chunks):
        body = "".join("<tr><td>%s</td><td>%s</td></tr>" % (code, meaning) for code, meaning in chunk)
        tables.append('<table id="%s"><tr><th>Code</th><th>Definition</th></tr>%s</table>' % (table_id, body))
    return ("<html><body>%s</body></html>" % "".join(tables)).encode("utf-8")


EXCLUSIVITY_CODES = [("NCE", "NEW CHEMICAL ENTITY"), ("I-9100", "A NEW INDICATION &amp; A SECOND CLAUSE"), ("ODE-9200", "ORPHAN INDICATION"), ("PED", "PEDIATRIC EXCLUSIVITY")]
USE_CODES = [("U-9001", "METHOD OF TREATING INVENTED CONDITION ONE"), ("U-9002", "METHOD OF TREATING INVENTED CONDITION TWO"), ("U-9003", "A THIRD INVENTED USE")]


def _zip(files):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, text in files.items():
            archive.writestr(name, text)
    return buffer.getvalue()


def payloads(**options):
    return {
        "orange-book.zip": orange_book_zip(**options.get("orange_book", {})),
        "drugsatfda.zip": drugs_at_fda_zip(**options.get("drugs_at_fda", {})),
        "exclusivity-codes.html": code_page(EXCLUSIVITY_CODES + [("X%d" % number, "FILLER %d" % number) for number in range(30)], table_ids=("example0", "example1")),
        "patent-use-codes.html": code_page(USE_CODES + [("U-%d" % number, "FILLER USE %d" % number) for number in range(1, 1100)]),
    }


def pins_for(payload_set):
    """SOURCES entries that pin exactly these invented bytes."""
    return {
        name: {"url": "https://example.invalid/" + name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "label": name}
        for name, data in payload_set.items()
    }
