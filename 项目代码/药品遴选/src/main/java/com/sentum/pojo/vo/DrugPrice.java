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
@Document("evaluation_drug_price")
public class DrugPrice {
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
     * 价格
     */
    @ApiModelProperty("价格")
    private Double priceLevel;

    /**
     * 同类药品的唯一id
     */
    private String priceId;
}
