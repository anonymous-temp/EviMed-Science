package com.sentum.evidencecomprehensive.pojo.bo;

import lombok.Data;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2024/6/19
 */
@Data
public class DrugParamBo {

    /**
     * 内容类型 text、 table、 img 
     */
    private String tag;

    /**
     * 内容
     */
    private Object content;
}
