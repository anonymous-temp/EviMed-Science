package com.sentum.pojo.dto;

import lombok.Data;
import lombok.NoArgsConstructor;

import java.io.Serializable;

@Data
@NoArgsConstructor
public class Asynchronous implements Serializable {

    /**
     * 药品名称
     */
    private String drugName;

    /**
     * 疾病
     */
    private String disease;

    /**
     * 药品id
     */
    private String drugId;

    /**
     * 规格
     */
    private String drugSpecifications;

    /**
     * 价格id
     */
    private String priceId;

    /**
     * 是否自定义药品
     */
    private String isCustom;


}