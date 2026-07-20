package com.sentum.drugsafe.pojo;

import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

@Data
@AllArgsConstructor
@Document("adrs_summary_content")
public class SummaryContentVO {
    @Id
    private String id;
    @ApiModelProperty("内容")
    private String content;
}
