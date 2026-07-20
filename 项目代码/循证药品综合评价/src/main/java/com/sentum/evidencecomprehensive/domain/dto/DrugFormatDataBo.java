package com.sentum.evidencecomprehensive.domain.dto;

import lombok.Data;

@Data
public class DrugFormatDataBo {
    /**
     * 内容类型 text、 table、 img
     */
    private String tag;

    /**
     * 内容
     */
    private Object content;
}
