package com.sentum.evidencecomprehensive.pojo.bo.mongo;

import com.sentum.evidencecomprehensive.pojo.bo.DrugParamBo;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;

import java.util.List;

/**
 * 合理用药说明书数据
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
    private List<DrugParamBo> indicationsDosage;

    /**
     * 药理作用
     */
    private List<DrugParamBo> pharmacology;

    /**
     * 药代动力学
     */
    private List<DrugParamBo> pharmacokinetics;

    /**
     * 黑框警告
     */
    private List<DrugParamBo> warning;

    /**
     * 儿童&老人用药
     */
    private List<DrugParamBo> childrenAndGeriatricMedicine;

    /**
     * 儿童用药
     */
    private List<DrugParamBo> children;

    /**
     * 哺乳期用药
     */
    private List<DrugParamBo> medicationDuringLactation;

    /**
     * 妊娠期用药
     */
    private List<DrugParamBo> medicationDuringPregnancy;

    /**
     * 注意事项
     */
    private List<DrugParamBo> notes;

    /**
     * 禁忌
     */
    private List<DrugParamBo> taboo;

    /**
     * 贮藏
     */
    private List<DrugParamBo> storage;

    /**
     * 不良反应
     */
    private List<DrugParamBo> adverseReaction;
}
