package com.sentum.evidencecomprehensive.domain.mongo;

import com.fasterxml.jackson.annotation.JsonIgnore;
import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.mongodb.core.mapping.Document;

import java.time.Instant;

/**
 * 用户检索条件存储类
 * @author zgm
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@Document("evidence_condition_guide_alt")
public class ConditionGuideAlter extends BaseCondition {

    // ####################### pico检索 ##########################
   
    @JsonIgnore
    private Long updateTime = Instant.now().toEpochMilli();

    // ####################### 高级检索 ##########################
    @ApiModelProperty("检索式")
    private String mode;
    @ApiModelProperty(" 中英文扩展 1选中 0未选中")
    private String zhEnExtension;
    @ApiModelProperty("同义词扩展  1选中 0未选中")
    private String synonymExtension;
}
