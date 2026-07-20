package com.sentum.evidencecomprehensive.pojo.bo.mongo;

import com.sentum.evidencecomprehensive.pojo.bo.DrugParamBo;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.mongodb.core.mapping.Document;

import java.util.List;

/**
 * 说明书原文数据
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@Document("evaluation_assistant_instructions_use")
public class MedicineInstructionUse {

    private String id;

    /**
     * 成分
     */
    private String innName;

    /**
     * 药品名称
     */
    private String commonName;

    /**
     * 适应症
     */
    private List<DrugParamBo> indication;

    /**
     * dosage
     */
    private List<DrugParamBo> dosage;

    /**
     * 药理作用
     */
    private List<DrugParamBo> mechanismAction;

    /**
     * 药代动力学
     */
    private List<DrugParamBo> pharmacokinetics;

    /**
     * 黑框警告
     */
    private List<DrugParamBo> drugWarning;

    /**
     * 儿童用药
     */
    private List<DrugParamBo> useInChildren;

    /**
     * 老人
     */
    private List<DrugParamBo> useInElderly;

    /**
     * 妊娠期用药
     */
    private List<DrugParamBo> useInPregLact;

    /**
     * 禁忌
     */
    private List<DrugParamBo> contraindications;

    /**
     * 注意事项
     */
    private List<DrugParamBo> precautions;

    /**
     * 相互作用
     */
    private List<DrugParamBo> drugInteractions;

    /**
     * 不良反应
     */
    private List<DrugParamBo> adverseReactions;

    /**
     * 贮藏
     */
    private List<DrugParamBo> storage;

}
