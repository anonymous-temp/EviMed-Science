package com.evimed.agent.evidence.agentevidencebased.entity.index;

import com.evimed.agent.evidence.agentevidencebased.entity.annotation.EsDocument;
import lombok.Data;
import org.springframework.data.annotation.Id;

/**
 * 说明书VO
 * @author  wangxm
 */
@Data
@EsDocument(index = "instruction_data_index")
public class InstructionIndex {
    @Id
    private String id;
    private String pdf_name;
    private String genericNames;
    private String simpleGenericNames;
    private String englishName;
    private String simpleEnglishName;
    private String tradeNames;
    private String simpleTradeNames;
    private String indication;
    private String simpleIndication;
    private String enterpriseName;
    private String taboo;
    private String approvalDates;
    private String revisionDate;
    private String source;
    private String usage;
    private String pharmacology;    // 药理作用（ES字段 pharmacology，可能为空）
    private Boolean medicineUsePdf;
    private String instructionId;
    private String detailId;
    private String specifications;
}
