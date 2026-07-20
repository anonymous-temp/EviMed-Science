package com.sentum.pojo;

import lombok.Data;

@Data
public class StreamParams {

    /**
     * 药品id,多个药品需要英文","隔开
     */
    private String drugId;
    /**
     * 疾病
     */
    private String disease;

    /**
     * 搜索id
     */
    private String searchId;


    private String scaleId;

}
