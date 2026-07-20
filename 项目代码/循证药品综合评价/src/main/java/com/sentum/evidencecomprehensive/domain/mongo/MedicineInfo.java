package com.sentum.evidencecomprehensive.domain.mongo;

import com.sentum.evidencecomprehensive.domain.dto.DrugFormatDataBo;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;

import java.util.List;

/**
 * 药品信息表
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@Document("evaluation_medicine")
public class MedicineInfo {

    @Field("_id")
    private String id;

    /**
     * 药品名称
     */
    private String drugName;

    /**
     * 适应症与用法用量
     */
   private List<DrugFormatDataBo> indicationsDosage;

    /**
     * 药理作用
     */
    private List<DrugFormatDataBo> pharmacology;

    /**
     * 药代动力学
     */
    private List<DrugFormatDataBo> pharmacokinetics;

    /**
     * 黑框警告
     */
    private List<DrugFormatDataBo> warning;

    /**
     * 儿童&老人用药
     */
    private List<DrugFormatDataBo> childrenAndGeriatricMedicine;

    /**
     * 儿童用药
     */
    private List<DrugFormatDataBo> children;

    /**
     * 哺乳期用药
     */
    private List<DrugFormatDataBo> medicationDuringLactation;

    /**
     * 妊娠期用药
     */
    private List<DrugFormatDataBo> medicationDuringPregnancy;

    /**
     * 注意事项
     */
    private List<DrugFormatDataBo> notes;

    /**
     * 禁忌
     */
    private List<DrugFormatDataBo> taboo;

    /**
     * 贮藏
     */
    private List<DrugFormatDataBo> storage;

    /**
     * 不良反应
     */
    private List<DrugFormatDataBo> adverseReaction;
}
