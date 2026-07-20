package com.sentum.pojo;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

/**
 * 药品价格表对应实体类
 * @author zgm
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@Document("evaluation_drug_price")
public class DrugAndPrice {
    @Id
    private String id;
    /**
     * 药品名称
     */
    private String drugName;
    /**
     * 产品名称
     */
    private String productName;
    /**
     * 中文通用名
     */
    private String commonName;
    /**
     * 药品规格
     */
    private String specifications;
    /**
     * 转换比
     */
    private String conversionRate;
    /**
     * 药品剂型
     */
    private String dosageForm;
    /**
     * 药品厂家
     */
    private String manufacturer;
    /**
     * 中标价格
     */
    private String bidWinningPrice;
    /**
     * 支付类型
     */
    private String paymentType;
    /**
     * 支付范围
     */
    private String paymentScope;
    /**
     * 是否是国家基本药物
     */
    private String essentialMedicines;
}
