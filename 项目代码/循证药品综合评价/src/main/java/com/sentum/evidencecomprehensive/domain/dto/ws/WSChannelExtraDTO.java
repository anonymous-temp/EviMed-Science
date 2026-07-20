package com.sentum.evidencecomprehensive.domain.dto.ws;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * @Description: 存储在线用户的信息  实体类 便于后续扩展用户信息
 */

@Data
@AllArgsConstructor
@NoArgsConstructor
@Builder
public class WSChannelExtraDTO {

    /**
     * 记录前端登录用户 uid
     */
    private Long uid;
}
