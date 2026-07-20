package com.sentum.evidencecomprehensive.pojo.bo.es;

import lombok.Data;
import org.springframework.data.elasticsearch.annotations.Document;

import java.util.List;

/**
 * 说明书索引类
 */
@Data
@Document(indexName = "instruction_data_index")
public class InstructionIndex {
    /**
     * 说明书存储的实际编号名称
     */
    private String pdf_name;
    /**
     * 说明书名称
     */
    private String simpleGenericNames;
    /**
     * 说明书英文名称
     */
    private String simpleEnglishName;
    /**
     * 商品名称
     */
    private String simpleTradeNames;
    /**
     * 商品名称
     */
    private String tradeNames;
    /**
     * 说明书的适应症
     */
    private String indication;
    /**
     * 说明书的适应症
     */
    private List<String> indicationForNew;
    /**
     * 厂家名称
     */
    private String enterpriseName;
    /**
     * 说明书来源，NMPA、FDA、EMA、PMDA
     */
    private String source;
    /**
     * 说明书发表日期
     */
    private String revisionDate;

    /**
     * 是否是用药助手说明书
     */
    private Boolean medicineUsePdf;
}
