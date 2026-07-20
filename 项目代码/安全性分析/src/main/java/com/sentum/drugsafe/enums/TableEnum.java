package com.sentum.drugsafe.enums;

import lombok.AllArgsConstructor;
import lombok.NoArgsConstructor;

/**
 * 表名的枚举类
 * @author zgm
 */
@AllArgsConstructor
@NoArgsConstructor
public enum TableEnum {
    /**
     * 药品名+不良反应查询时间扫描图谱
     */
    PictureForDrug("zgm_fda_adrs_year_picture_data_drugname", 1),

    /**
     * 有效成分+不良反应查询时间扫描图谱
     */
    PictureForProdAi("zgm_fda_adrs_year_picture_data_prod_ai", 2),

    /**
     * 药品有效成分-药品名+计量对应表(中英文格式都包含)
     */
    DrugInstructionWords("drug_instruction_words", 3),

    /**
     * 多级药品词的映射关系
     */
    DrugNameWords("drug_name_words", 4),

    /**
     * fda+vigi的不良反应
     */
    FdaVigiPharma("zgm_fda_vigi_pharma", 5),

    /**
     * 药品名称信息表
     */
    FdaDrugIAlert("zgm_fda_drug_i", 6),

    /**
     * 药品有效成分信息表
     */
    FdaDrugIAlertProdAi("zgm_fda_drug_i_prod_ai", 7),

    /**
     * vigi 药品数据
     */
    VigiDrugIAlert("zgm_vigi_drug_i", 8),

    /**
     * o+药品名
     */
    FdaDrugAlert("zgm_fda_drug", 97),

    /**
     * o+有效成分
     */
    FdaDrugAlertProdAi("zgm_fda_drug_prod_ai", 10),

    /**
     * 不良反应表
     */
    ADRS("zgm_adrs", 11);


    private String msg;
    private Integer code;

    public String getMsg() {
        return msg;
    }

    public void setMsg(String msg) {
        this.msg = msg;
    }

    public Integer getCode() {
        return code;
    }

    public void setCode(Integer code) {
        this.code = code;
    }
}
