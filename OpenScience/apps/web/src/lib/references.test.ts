import { describe, expect, it } from "vitest";
import { bareDoi, formatGbt7714, formatVancouver, identifiersOf, type ReferenceMetadata } from "./references";

/** Spec §15.9's Chinese example. */
const YAN: ReferenceMetadata = {
  authors: ["严若华", "彭晓霞"],
  title: "医学期刊统计报告要求的详述与解读",
  journal: "中华流行病学杂志",
  year: 2019,
  volume: 40,
  issue: 1,
  pages: "99–105",
  doi: "10.3760/cma.j.issn.0254-6450.2019.01.020",
};

/** Spec §15.9's English example (BMJ 2009;338:a2752). */
const ZHANG: ReferenceMetadata = {
  authors: ["Zhang M", "Holman CD", "Price SD", "Sanfilippo FM", "Preen DB", "Bulsara MK"],
  title: "Comorbidity and repeat admission to hospital for adverse drug reactions in older adults: retrospective cohort study",
  journal: "BMJ",
  year: 2009,
  volume: 338,
  pages: "a2752",
  doi: "https://doi.org/10.1136/bmj.a2752",
  pmid: "19129307",
};

describe("GB/T 7714—2015 (spec §15.9)", () => {
  it("writes the spec's own example, number and all", () => {
    expect(formatGbt7714(YAN, 1)).toBe(
      "[1] 严若华, 彭晓霞. 医学期刊统计报告要求的详述与解读[J]. 中华流行病学杂志, 2019, 40(1): 99-105. DOI: 10.3760/cma.j.issn.0254-6450.2019.01.020.",
    );
  });

  it("writes a Latin name family first in capitals with spaced initials, three names then et al., and the PMID after the DOI", () => {
    expect(formatGbt7714(ZHANG)).toBe(
      "ZHANG M, HOLMAN C D, PRICE S D, et al. Comorbidity and repeat admission to hospital for adverse drug reactions in older adults: "
      + "retrospective cohort study[J]. BMJ, 2009, 338: a2752. DOI: 10.1136/bmj.a2752. PMID: 19129307.",
    );
  });

  it("writes 等 after three Chinese names", () => {
    const four = { ...YAN, authors: ["严若华", "彭晓霞", "张三", "李四"] };
    expect(formatGbt7714(four)).toMatch(/^严若华, 彭晓霞, 张三, 等\. 医学期刊/);
  });

  it("keeps an issue without a volume against the year, and leaves out what the source does not record", () => {
    expect(formatGbt7714({ title: "中药注射剂不良反应监测", journal: "中国药物警戒", year: "2024", issue: "3" }))
      .toBe("中药注射剂不良反应监测[J]. 中国药物警戒, 2024(3).");
    // A report's card often knows only the title and the identifier: an
    // article (the PMID says so) that begins with its title, as the
    // sequential system allows for an entry with no responsible person.
    expect(formatGbt7714({ title: "Aspirin in the Primary Prevention of Cardiovascular Disease.", pmid: 30221597 }))
      .toBe("Aspirin in the Primary Prevention of Cardiovascular Disease[J]. PMID: 30221597.");
  });

  it("writes a page read online as [EB/OL] with its date and address, and an organisation as its name", () => {
    expect(formatGbt7714({
      authors: ["World Health Organization"],
      title: "Hypertension fact sheet",
      year: "2023",
      url: "https://www.who.int/news-room/fact-sheets/detail/hypertension",
    })).toBe("World Health Organization. Hypertension fact sheet[EB/OL]. (2023). https://www.who.int/news-room/fact-sheets/detail/hypertension.");
  });
});

describe("Vancouver (spec §15.9)", () => {
  it("writes the spec's own example, number and all", () => {
    expect(formatVancouver(ZHANG, 1)).toBe(
      "1. Zhang M, Holman CD, Price SD, Sanfilippo FM, Preen DB, Bulsara MK. Comorbidity and repeat admission to hospital for adverse drug "
      + "reactions in older adults: retrospective cohort study. BMJ. 2009;338:a2752. doi:10.1136/bmj.a2752. PMID: 19129307.",
    );
  });

  it("writes six names then et al., and initials run together whatever form they came in", () => {
    const seven = {
      ...ZHANG,
      authors: [
        { family: "Ridker", given: "Paul M" }, "Holman, C D'Arcy J", "Price S. D.", "Sanfilippo FM", "Preen DB", "Bulsara MK", "Zhang M",
      ],
    };
    expect(formatVancouver(seven)).toMatch(/^Ridker PM, Holman CDJ, Price SD, Sanfilippo FM, Preen DB, Bulsara MK, et al\. Comorbidity/);
  });

  it("writes volume, issue and pages as Year;Volume(Issue):Pages, and does not double a title's own stop", () => {
    expect(formatVancouver({
      authors: ["McNeil JJ"],
      title: "Effect of Aspirin on Cardiovascular Events and Bleeding in the Healthy Elderly?",
      journal: "N Engl J Med",
      year: 2018,
      volume: 379,
      issue: 16,
      pages: "1509–1518",
      doi: "10.1056/NEJMoa1805819",
    })).toBe("McNeil JJ. Effect of Aspirin on Cardiovascular Events and Bleeding in the Healthy Elderly? N Engl J Med. 2018;379(16):1509-1518. doi:10.1056/NEJMoa1805819.");
  });

  it("writes a page read online as [Internet] with Available from", () => {
    expect(formatVancouver({ authors: ["World Health Organization"], title: "Hypertension fact sheet", year: 2023, url: "https://www.who.int/x" }))
      .toBe("World Health Organization. Hypertension fact sheet [Internet]. 2023. Available from: https://www.who.int/x");
  });

  it("keeps a Chinese name as written", () => {
    expect(formatVancouver(YAN)).toBe(
      "严若华, 彭晓霞. 医学期刊统计报告要求的详述与解读. 中华流行病学杂志. 2019;40(1):99-105. doi:10.3760/cma.j.issn.0254-6450.2019.01.020.",
    );
  });
});

describe("identifiers", () => {
  it("reads the DOI and PMID out of the ways a matrix writes them", () => {
    expect(identifiersOf("PMID:30221597")).toEqual({ pmid: "30221597" });
    expect(identifiersOf("DOI 10.1056/NEJMoa1805819")).toEqual({ doi: "10.1056/NEJMoa1805819" });
    expect(identifiersOf("doi:10.1136/bmj.a2752", "https://pubmed.ncbi.nlm.nih.gov/19129307/")).toEqual({ doi: "10.1136/bmj.a2752" });
    expect(identifiersOf("https://doi.org/10.1136/bmj.a2752", "pmid 19129307")).toEqual({ doi: "10.1136/bmj.a2752", pmid: "19129307" });
    expect(identifiersOf("NCT01234567", undefined, "")).toEqual({});
    expect(bareDoi("https://dx.doi.org/10.1/x")).toBe("10.1/x");
  });
});
