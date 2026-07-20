package com.sentum.evidencecomprehensive.pojo.vo.req;

import lombok.Getter;
import lombok.Setter;

@Setter
@Getter
public class PaperInfoEditRequest {
    private String paperId;
    private String questionId;
    /**
     * 评价标准id
     */
    private String infoId;
    private String content;
}
