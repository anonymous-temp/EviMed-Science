package com.sentum.evidencecomprehensive.pojo.vo.req;

import io.swagger.annotations.ApiModelProperty;
import lombok.Getter;
import lombok.Setter;

@Setter
@Getter
public class PaperStandardRequest {
    private String paperId;
    private String questionId;
    /**
     * 评价标准id
     */
    private String standardId;
    /**
     * 更改内容·
     */
    private String standardValue;
}
