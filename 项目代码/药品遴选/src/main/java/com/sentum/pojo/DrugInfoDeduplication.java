package com.sentum.pojo;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

import java.util.List;
import java.util.Objects;

/**
 * 药品信息表;去重专用表，去重字段drugName，manufacturer
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@Document("evaluation_drug_info")
public class DrugInfoDeduplication {
    @Id
    private String id;
    /**
     * 药品名称
     */
    private String drugName;
    /**
     * 药品厂家
     */
    private String manufacturer;

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (o == null || getClass() != o.getClass()) return false;
        DrugInfoDeduplication that = (DrugInfoDeduplication) o;
        return Objects.equals(drugName, that.drugName) && Objects.equals(manufacturer, that.manufacturer) && Objects.equals(unitPrice, that.unitPrice);
    }

    @Override
    public int hashCode() {
        return Objects.hash(drugName, manufacturer, unitPrice);
    }

    /**
     * 注册账号
     */
    private String register;
    /**
     * 药品规格
     */
    private String specifications;
    /**
     * 剂型
     */
    private String dosageForm;
    /**
     * 商品中文
     */
    private String communityNameZh;
    /**
     * 商品英文
     */
    private String communityNameEn;
    /**
     * 一级中文
     */
    private String oneNameZh;
    /**
     * 一级英文
     */
    private String oneNameEn;
    /**
     * 二级中文
     */
    private String twoNameZh;
    /**
     * 二级英文
     */
    private String twoNameEn;
    /**
     * 三级中文
     */
    private String threeNameZh;
    /**
     * 三级英文
     */
    private String threeNameEn;
    /**
     * 四级中文
     */
    private String fourNameZh;
    /**
     * 四级英文
     */
    private String fourNameEn;
    /**
     * 五级编码
     */
    private String fiveCoding;
    /**
     * 五级英文
     */
    private String drugEn;
    /**
     * 五级英文同义词
     */
    private List<String> drugSynonymEn;
    /**
     * 五级中文
     */
    private String drugZh;
    /**
     * 五级中文同义词
     */
    private List<String> drugSynonymZh;
    /**
     * 医保情况
     */
    private String medicalInsurance;
    /**
     * 支付范围
     */
    private String paymentScope;
    /**
     * 是否是国家基本药物
     */
    private String essentialMedicines;
    /**
     * 是否有△要求
     */
    private String essentialType;
    /**
     * 适应症
     */
    private String indication;
    /**
     * 中文疾病名称
     */
    private List<String> diseaseZh;
    /**
     * 英文疾病名称
     */
    private List<String> diseaseEn;
    /**
     * 疾病同义词
     */
    private List<String> diseaseSynonym;
    /**
     * 该药品的皮试情况
     */
    private String skinTest;
    /**
     * 集中采药情况
     */
    private String drugCollection;
    /**
     * 药理作用
     */
    private String pharmacology;
    /**
     * 药代动力学
     */
    private String pharmacokinetics;
    /**
     * 用法用量
     */
    private String usageAndDosage;
    /**
     * 贮藏
     */
    private String storage;
    /**
     * 有效期
     */
    private String indate;
    /**
     * 主治/适应症
     */
    private String indications;
    /**
     * 不良反应
     */
    private String adverseReaction;
    /**
     * 孕妇及哺乳期妇女
     */
    private String pregnantWomen;
    /**
     * 儿童用药
     */
    private String childrenMedicine;
    /**
     * 老人用药
     */
    private String geriatricMedicine;
    /**
     * 药物相互作用
     */
    private String drugInteraction;
    /**
     * 原研药
     */
    private String originalDrug;
    /**
     * 参比药品
     */
    private String referenceDrug;
    /**
     * 一致性评价药品
     */
    private String consistencyDrug;
    /**
     * 成分
     */
    private String ingredient;
    /**
     * 注意事项
     */
    private String notes;
    /**
     * 禁忌
     */
    private String taboo;
    /**
     * 单位
     */
    private String unit;
    /**
     * 单位价格
     */
    private String unitPrice;
    /**
     * 价格
     */
    private String price;
    /**
     * 转换比
     */
    private String ratio;
    /**
     * 集采药品中标价格（元）
     */
    private String outbidPrice;
    /**
     * 包装
     */
    private String pack;

    /**
     * 规格-说明书
     */
    private String specificationsIns;


}
