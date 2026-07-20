package com.sentum.evidencecomprehensive.domain.dto;

import lombok.Data;

/**
 * Description:
 */
@Data
public class FormatDataDTO {

    /**
     * 内容类型 text、 img 
     */
    private String type;

    /**
     * 内容
     */
    private String data;
}
