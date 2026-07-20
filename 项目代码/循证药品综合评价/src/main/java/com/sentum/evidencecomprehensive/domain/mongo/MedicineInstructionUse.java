package com.sentum.evidencecomprehensive.domain.mongo;

import com.sentum.evidencecomprehensive.domain.dto.DrugFormatDataBo;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.mongodb.core.mapping.Document;

import java.util.List;

/**
 * 药品信息表
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
   private List<DrugFormatDataBo> indication;

    /**
     * 功能主治
     */
    private List<DrugFormatDataBo> effectsAndIndications;

    /**
     * dosage
     */
    private List<DrugFormatDataBo> dosage;

    /**
     * 药理作用
     */
    private List<DrugFormatDataBo> mechanismAction;

    /**
     * 药代动力学
     */
    private List<DrugFormatDataBo> pharmacokinetics;

    /**
     * 黑框警告
     */
    private List<DrugFormatDataBo> drugWarning;
    
    /**
     * 儿童用药
     */
    private List<DrugFormatDataBo> useInChildren;

    /**
     * 老人
     */
    private List<DrugFormatDataBo> useInElderly;

    /**
     * 妊娠期用药
     */
    private List<DrugFormatDataBo> useInPregLact;

    /**
     * 禁忌
     */
    private List<DrugFormatDataBo> contraindications;

    /**
     * 注意事项
     */
    private List<DrugFormatDataBo> precautions;

    /**
     * 相互作用
     */
    private List<DrugFormatDataBo> drugInteractions;

    /**
     * 不良反应
     */
    private List<DrugFormatDataBo> adverseReactions;

    /**
     * 贮藏
     */
    private List<DrugFormatDataBo> storage;
}
