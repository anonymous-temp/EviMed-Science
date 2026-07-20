package com.sentum.evidencecomprehensive.pojo.bo.mongo;

import cn.hutool.core.date.DateTime;
import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.Data;
import org.springframework.data.mongodb.core.mapping.Document;

/**
 * Description: 文献进行排除时的理由
 */
@Data
@ApiModel(value = "文献进行排除时的理由")
@Document("evidence_exclude_reason")
public class ExcludeReasonBo {
    @ApiModelProperty("文献id")
    private String id;
    @ApiModelProperty("用户id")
    private long userId;
    @ApiModelProperty("排除理由")
    private String reason;
    @ApiModelProperty("操作时间")
    private DateTime updateTime;
    @ApiModelProperty("操作时间")
    private long updateTimeLong;
}
