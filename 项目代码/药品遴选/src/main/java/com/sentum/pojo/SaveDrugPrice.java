package com.sentum.pojo;

import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

/**
 * 将用户输入的药品价格数据存储
 * @author zgm
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@Document("evaluation_save_drug_price")
public class SaveDrugPrice {
    @Id
    private String id;
    /**
     * 药品名称
     */
    @ApiModelProperty("药品名称")
    private String drugName;
    /**
     * 药品规格
     */
    @ApiModelProperty("药品规格")
    private String specifications;
    /**
     * 转换比
     */
    @ApiModelProperty("转换比")
    private String conversionRate;
    /**
     * 药品厂家
     */
    @ApiModelProperty("药品厂家")
    private String manufacturer;
    /**
     * 日均治疗费用
     */
    @ApiModelProperty("日均治疗费用")
    private Double averageDailyCost;
    /**
     * 同通用名日均治疗最低费用
     */
    @ApiModelProperty("同通用名日均治疗最低费用")
    private Double minAverageDailyCost;
    /**
     * 可替代日均治疗最低费用
     */
    @ApiModelProperty("可替代日均治疗最低费用")
    private Double alternativeMinAverageDailyCost;
    /**
     * 同类药品的唯一id
     */
    private String priceId;
}
